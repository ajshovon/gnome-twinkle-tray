import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MonitorStore} from './ddc.js';
import {TwinkleIndicator, showBrightnessOsd} from './indicator.js';

const DISPLAY_CONFIG = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';
const POWER_SAVE_ON = 0;
const POWER_SAVE_OFF = 3;
const HOTPLUG_SETTLE_MS = 1500;
const SHORTCUTS = ['shortcut-turn-off', 'shortcut-brightness-up', 'shortcut-brightness-down'];

function setPowerSaveMode(mode) {
    Gio.DBus.session.call(DISPLAY_CONFIG, DISPLAY_CONFIG_PATH,
        'org.freedesktop.DBus.Properties', 'Set',
        new GLib.Variant('(ssv)', [DISPLAY_CONFIG, 'PowerSaveMode', new GLib.Variant('i', mode)]),
        null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
            try {
                bus.call_finish(res);
            } catch (e) {
                console.error(`[twinkle-tray] PowerSaveMode=${mode}: ${e.message}`);
            }
        });
}

export default class TwinkleTrayExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new MonitorStore(this.dir.get_child('ddc-helper.py').get_path(), this._settings);
        this._indicator = new TwinkleIndicator(this, this._store);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();

        // The helper only touches I2C for monitors it hasn't seen yet, so re-detecting on every
        // change is cheap; it picks up monitors being plugged in or waking up.
        global.backend.get_monitor_manager().connectObject('monitors-changed', () => {
            if (this._hotplugId)
                GLib.source_remove(this._hotplugId);
            this._hotplugId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOTPLUG_SETTLE_MS, () => {
                this._hotplugId = 0;
                if (!this._activeWatchId)
                    this._store.detect();
                return GLib.SOURCE_REMOVE;
            });
        }, this);

        const step = () => this._settings.get_int('step') / 100;
        this._addKeybinding('shortcut-turn-off', () => this.turnOffDisplays());
        this._addKeybinding('shortcut-brightness-up', () => showBrightnessOsd(this._store.adjustBrightness(step())));
        this._addKeybinding('shortcut-brightness-down', () => showBrightnessOsd(this._store.adjustBrightness(-step())));

        this._store.detect();
    }

    _addKeybinding(key, handler) {
        Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, handler);
    }

    _syncSessionMode() {
        // We stay enabled on the lock screen only so a pending wake-on-input watch survives
        // the session locking while displays are off; the panel icon is hidden there.
        const locked = Main.sessionMode.isLocked;
        this._indicator.visible = !locked;
        if (locked)
            this._indicator.menu.close();
    }

    /**
     * Blanks all outputs via Mutter (the Wayland equivalent of TwinkleTray's SC_MONITORPOWER),
     * then turns them back on at the next keyboard or mouse input.
     */
    turnOffDisplays() {
        this._indicator.menu.close();
        if (this._turnOffId)
            GLib.source_remove(this._turnOffId);
        this._turnOffId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._settings.get_int('turn-off-delay'), () => {
            this._turnOffId = 0;
            const idleMonitor = global.backend.get_core_idle_monitor();
            if (this._activeWatchId)
                idleMonitor.remove_watch(this._activeWatchId);
            setPowerSaveMode(POWER_SAVE_OFF);
            this._activeWatchId = idleMonitor.add_user_active_watch(() => {
                this._activeWatchId = 0;
                setPowerSaveMode(POWER_SAVE_ON);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        for (const key of SHORTCUTS)
            Main.wm.removeKeybinding(key);
        for (const id of [this._turnOffId, this._hotplugId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._turnOffId = this._hotplugId = 0;
        if (this._activeWatchId) {
            // Never leave the screens dark with nothing left to wake them.
            global.backend.get_core_idle_monitor().remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
            setPowerSaveMode(POWER_SAVE_ON);
        }
        global.backend.get_monitor_manager().disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._indicator.destroy();
        this._indicator = null;
        this._store.destroy();
        this._store = null;
        this._settings = null;
    }
}
