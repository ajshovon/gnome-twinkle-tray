// Talks to ddc-helper.py (one long-lived process) and holds the monitor model the UI binds to.
//
// Performance rules, learned the hard way on NVIDIA where every I2C transfer busy-waits
// ~25 ms in the kernel and stalls the compositor:
//  - never spawn per request (forking gnome-shell blocks its main thread),
//  - never read DDC values when the menu opens; values are cached and only re-read on
//    detection, on explicit refresh, or when stale after the menu closes,
//  - throttle writes per monitor/feature like TwinkleTray's "update rate" (leading +
//    trailing edge), and let the helper coalesce whatever still queues up.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

export const VCP_BRIGHTNESS = 0x10;
export const VCP_CONTRAST = 0x12;

const RESTART_BACKOFF_US = 5 * GLib.USEC_PER_SEC;
const STALE_AFTER_US = 10 * 60 * GLib.USEC_PER_SEC;
const STALE_REFRESH_DELAY_MS = 1000;

const clamp01 = x => Math.max(0, Math.min(1, x));

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

class HelperClient extends Signals.EventEmitter {
    constructor(argv) {
        super();
        this._argv = argv;
        this._proc = null;
        this._nextId = 1;
        this._pending = new Map();
        this._writes = Promise.resolve();
        this._startedAt = -RESTART_BACKOFF_US;
    }

    _ensureRunning() {
        if (this._proc)
            return true;
        if (this._destroyed || GLib.get_monotonic_time() - this._startedAt < RESTART_BACKOFF_US)
            return false;
        this._startedAt = GLib.get_monotonic_time();
        let proc;
        try {
            proc = Gio.Subprocess.new(this._argv,
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            console.error(`[twinkle-tray] cannot start DDC helper: ${e.message}`);
            return false;
        }
        this._proc = proc;
        this._stdin = proc.get_stdin_pipe();
        this._cancellable = new Gio.Cancellable();
        this._readReply(new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}), this._cancellable);
        proc.wait_async(null, (_p, res) => {
            try {
                proc.wait_finish(res);
            } catch {}
            this._onExit(proc);
        });
        return true;
    }

    _readReply(stdout, cancellable) {
        // Explicit callback rather than a promise: read_line_async may already be promisified
        // shell-wide with the byte-returning finish function.
        stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_stream, res) => {
            let line;
            try {
                [line] = stdout.read_line_finish_utf8(res);
            } catch (e) {
                if (!isCancelled(e))
                    console.warn(`[twinkle-tray] reading DDC helper output: ${e.message}`);
                return;
            }
            if (line === null)
                return;
            this._handleReply(line);
            this._readReply(stdout, cancellable);
        });
    }

    _handleReply(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        const pending = this._pending.get(msg.id);
        if (!pending)
            return;
        this._pending.delete(msg.id);
        if (msg.error)
            pending.reject(new Error(msg.error));
        else
            pending.resolve(msg);
    }

    _onExit(proc) {
        if (proc !== this._proc)
            return;
        this._proc = null;
        this._cancellable.cancel();
        this._failPending(new Error('DDC helper exited'));
        if (!this._destroyed) {
            const how = proc.get_if_signaled() ? `signal ${proc.get_term_sig()}` : `status ${proc.get_exit_status()}`;
            console.warn(`[twinkle-tray] DDC helper exited (${how}); restarting`);
            this.emit('exited');
        }
    }

    _failPending(error) {
        for (const {reject} of this._pending.values())
            reject(error);
        this._pending.clear();
    }

    _write(message) {
        if (!this._ensureRunning())
            return false;
        const stdin = this._stdin;
        const bytes = new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
        // Async and chained: a wedged helper must never block the shell on a full pipe.
        this._writes = this._writes
            .then(() => stdin.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null))
            .catch(e => console.warn(`[twinkle-tray] writing to DDC helper: ${e.message}`));
        return true;
    }

    request(op, params = {}) {
        return new Promise((resolve, reject) => {
            const id = this._nextId++;
            this._pending.set(id, {resolve, reject});
            if (!this._write({id, op, ...params})) {
                this._pending.delete(id);
                reject(new Error('DDC helper is not running'));
            }
        });
    }

    /** Fire-and-forget; false if the helper isn't running (e.g. restarting after a crash). */
    send(op, params = {}) {
        return this._write({op, ...params});
    }

    destroy() {
        this._destroyed = true;
        this._failPending(new Error('destroyed'));
        if (!this._proc)
            return;
        // Closing stdin lets the helper finish queued writes (e.g. the final brightness) and exit.
        const stdin = this._stdin;
        this._writes.then(() => stdin.close_async(GLib.PRIORITY_DEFAULT, null)).catch(() => {});
        this._cancellable.cancel();
        this._proc = null;
    }
}

export class Monitor {
    constructor(store, info) {
        this._store = store;
        this.key = info.key;
        /** VCP code -> {current, max} (raw monitor units) */
        this.values = new Map();
        this._throttle = new Map();
        /** VCP code -> raw value the monitor is known to have (read from it or written to it) */
        this._applied = new Map();
        this.update(info, true);
    }

    update(info, replaceValues) {
        this.name = info.name;
        this.connector = info.connector;
        this.error = info.error;
        for (const [code, [current, max]] of Object.entries(info.values)) {
            const c = Number(code);
            // Keep values the user just set and that may not have reached the monitor yet.
            if (!this.values.has(c) || (replaceValues && !this._throttle.get(c)?.source)) {
                this.values.set(c, {current, max});
                this._applied.set(c, current);
            }
        }
    }

    has(code) {
        return (this.values.get(code)?.max ?? 0) > 0;
    }

    getPercent(code) {
        const v = this.values.get(code);
        return v?.max ? v.current / v.max : null;
    }

    setPercent(code, fraction) {
        const v = this.values.get(code);
        if (v)
            this._setRaw(code, Math.round(clamp01(fraction) * v.max));
    }

    /** Steps by `delta` (fraction of the range), moving at least one raw unit. */
    adjust(code, delta) {
        const v = this.values.get(code);
        if (!v || !delta)
            return;
        const step = Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) * v.max));
        this._setRaw(code, v.current + step);
    }

    _setRaw(code, value) {
        const v = this.values.get(code);
        value = Math.max(0, Math.min(v.max, value));
        if (value === v.current)
            return;
        v.current = value;
        this._schedule(code);
    }

    _schedule(code) {
        let t = this._throttle.get(code);
        if (!t) {
            t = {last: -Infinity, source: 0};
            this._throttle.set(code, t);
        }
        if (t.source)
            return; // the pending trailing write will pick up the latest value
        const now = GLib.get_monotonic_time() / 1000;
        const wait = t.last + this._store.updateInterval - now;
        if (wait <= 0) {
            t.last = now;
            this._send(code);
            return;
        }
        t.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
            t.source = 0;
            t.last = GLib.get_monotonic_time() / 1000;
            this._send(code);
            return GLib.SOURCE_REMOVE;
        });
    }

    _send(code) {
        const value = this.values.get(code).current;
        if (this._applied.get(code) === value)
            return; // e.g. the slider came back to where it was within one throttle window
        if (this._store._client?.send('set', {key: this.key, code, value}))
            this._applied.set(code, value);
    }

    destroy() {
        for (const [code, t] of this._throttle) {
            if (t.source) {
                GLib.source_remove(t.source);
                t.source = 0;
                this._send(code); // flush, so the last change isn't lost
            }
        }
    }
}

export class MonitorStore extends Signals.EventEmitter {
    constructor(helperPath, settings) {
        super();
        this._settings = settings;
        const python = GLib.find_program_in_path('python3');
        this._client = python ? new HelperClient([python, '-I', '-S', helperPath]) : null;
        this._exitedId = this._client?.connect('exited', () => this._onHelperExited());
        this.monitors = [];
        this.issue = python ? null : 'no-python';
        this.detecting = false;
        this._readAt = 0;
        this._layout = '';
    }

    get updateInterval() {
        return this._settings.get_int('update-interval');
    }

    get controllable() {
        return this.monitors.filter(m => m.has(VCP_BRIGHTNESS));
    }

    /** Finds monitors. Cheap when nothing changed: the helper only touches I2C for new ones. */
    async detect({refresh = false} = {}) {
        if (!this._client)
            return;
        if (this.detecting) {
            this._again = {refresh: refresh || this._again?.refresh};
            return;
        }
        this.detecting = true;
        if (!this.monitors.length)
            this._emitLayout(true);
        try {
            const reply = await this._client.request(refresh ? 'refresh' : 'detect');
            if (this._destroyed)
                return;
            this._apply(reply, refresh);
        } catch (e) {
            if (this._destroyed)
                return;
            console.warn(`[twinkle-tray] detect: ${e.message}`);
            this.issue = 'helper-failed';
        } finally {
            this.detecting = false;
        }
        if (this._destroyed)
            return;
        this._emitLayout();
        const again = this._again;
        this._again = null;
        if (again)
            this.detect(again);
    }

    _apply(reply, refreshed) {
        const known = new Map(this.monitors.map(m => [m.key, m]));
        const next = [];
        for (const info of reply.displays) {
            let m = known.get(info.key);
            if (m) {
                known.delete(info.key);
                m.update(info, refreshed);
            } else {
                m = new Monitor(this, info);
            }
            next.push(m);
        }
        for (const gone of known.values())
            gone.destroy();
        this.monitors = next;
        this.issue = reply.issue;
        if (refreshed || !this._readAt)
            this._readAt = GLib.get_monotonic_time();
    }

    _emitLayout(force = false) {
        const layout = JSON.stringify([this.issue, this.detecting && !this.monitors.length,
            this.monitors.map(m => [m.key, m.error, [...m.values.keys()]])]);
        if (force || layout !== this._layout) {
            this._layout = layout;
            this.emit('changed');
        } else {
            this.emit('values-changed');
        }
    }

    /** Re-reads values (they may have been changed with the monitor's own buttons) when old. */
    refreshIfStale() {
        if (!this._readAt || GLib.get_monotonic_time() - this._readAt < STALE_AFTER_US || this._staleId)
            return;
        this._staleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STALE_REFRESH_DELAY_MS, () => {
            this._staleId = 0;
            this.detect({refresh: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Changes brightness of every monitor by `delta`; returns the new level for the OSD. */
    adjustBrightness(delta) {
        const monitors = this.controllable;
        if (!monitors.length)
            return null;
        if (this._settings.get_boolean('link-levels')) {
            monitors[0].adjust(VCP_BRIGHTNESS, delta);
            const level = monitors[0].getPercent(VCP_BRIGHTNESS);
            for (const m of monitors.slice(1))
                m.setPercent(VCP_BRIGHTNESS, level);
        } else {
            for (const m of monitors)
                m.adjust(VCP_BRIGHTNESS, delta);
        }
        this.emit('values-changed');
        return monitors[0].getPercent(VCP_BRIGHTNESS);
    }

    _onHelperExited() {
        // Re-read everything once the restart back-off has passed: writes may have been lost.
        if (this._restartId)
            return;
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 6, () => {
            this._restartId = 0;
            this.detect({refresh: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        for (const id of [this._staleId, this._restartId]) {
            if (id)
                GLib.source_remove(id);
        }
        for (const m of this.monitors)
            m.destroy();
        this.monitors = [];
        if (this._exitedId)
            this._client.disconnect(this._exitedId);
        this._client?.destroy();
        this._client = null;
    }
}
