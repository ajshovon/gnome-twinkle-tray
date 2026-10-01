#!/usr/bin/env python3
"""DDC/CI helper process for the Twinkle Tray GNOME Shell extension.

Speaks DDC/CI directly over /dev/i2c-N instead of running ddcutil per request:

* A VCP read is exactly one I2C write plus one I2C read and a VCP write is a single
  I2C write. ddcutil spends ~11 transfers on one read (EDID, capability checks,
  retries). On NVIDIA's driver every transfer busy-waits ~25 ms in the kernel and
  blocks the compositor meanwhile, so the transfer count is what makes the desktop
  stutter.
* It is started once, so gnome-shell never has to fork per request.
* Writes queued for the same monitor and feature are coalesced; only the latest
  value is sent.

Protocol: one JSON object per line on stdin, replies on stdout.
  {"id": 1, "op": "detect"}               -> {"id": 1, "displays": [...], "issue": null}
  {"id": 2, "op": "refresh"}              -> same, after re-reading every value
  {"op": "set", "key": K, "code": 16, "value": 40}       (no reply)
"""

import errno
import fcntl
import glob
import hashlib
import json
import os
import select
import sys
import time

I2C_SLAVE = 0x0703
I2C_SLAVE_FORCE = 0x0706
DDC_ADDR = 0x37
EDID_ADDR = 0x50
EDID_HEADER = bytes.fromhex('00ffffffffffff00')

HOST = 0x51                 # source address byte the host puts in its messages
DISPLAY = 0x6E              # display write address; seeds the request checksum
REPLY_SEED = 0x50           # seeds the checksum of replies
OP_GET, OP_GET_REPLY, OP_SET = 0x01, 0x02, 0x03

REPLY_DELAY = 0.04          # DDC/CI: wait 40 ms between a request and reading its reply
SETTLE = 0.05               # ...and 50 ms after a transaction before the next one
ATTEMPTS = 3
NACK = (errno.EIO, errno.ENXIO, errno.EREMOTEIO)
GONE = (errno.ENODEV, errno.EBADF, errno.ENOENT)
LOCK_TIMEOUT = 2.0

VCP_BRIGHTNESS, VCP_CONTRAST = 0x10, 0x12
DEFAULT_CODES = (VCP_BRIGHTNESS, VCP_CONTRAST)
FAILED_RETRY_AFTER = 60     # seconds before a monitor without DDC/CI is tried again
PROBE_RETRY_AFTER = 30      # seconds before unanswered buses are EDID-probed again
INTERNAL_PANELS = ('eDP', 'LVDS', 'DSI')  # GNOME already drives these via the backlight
DEBUG = bool(os.environ.get('TWINKLE_TRAY_DEBUG'))


def log(*args):
    print('twinkle-tray helper:', *args, file=sys.stderr, flush=True)


def checksum(data, seed):
    for b in data:
        seed ^= b
    return seed


class DdcError(Exception):
    pass


class NoDdc(DdcError):
    """Nothing answers at the DDC/CI address: unsupported, disabled, or asleep."""


class Bus:
    def __init__(self, num):
        self.num = num
        self.fd = None
        self.addr = None
        self.ready_at = 0.0

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
        self.fd = self.addr = None

    def _select(self, addr):
        if self.fd is None:
            self.fd = os.open(f'/dev/i2c-{self.num}', os.O_RDWR | os.O_CLOEXEC)
        if self.addr != addr:
            try:
                fcntl.ioctl(self.fd, I2C_SLAVE, addr)
            except OSError as e:
                if e.errno != errno.EBUSY:
                    raise
                # A kernel driver (e.g. ddcci) has claimed the address; share it like ddcutil does.
                fcntl.ioctl(self.fd, I2C_SLAVE_FORCE, addr)
            self.addr = addr

    def _transaction(self, addr, fn):
        """Runs fn() holding the same flock() ddcutil uses, honouring DDC/CI pacing."""
        self._select(addr)
        deadline = time.monotonic() + LOCK_TIMEOUT
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise DdcError(f'i2c-{self.num} is busy')
                time.sleep(0.01)
        try:
            delay = self.ready_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            return fn()
        except OSError as e:
            if e.errno in GONE:  # adapter went away (driver reload); reopen next time
                fd, self.fd, self.addr = self.fd, None, None
                os.close(fd)
            raise
        finally:
            self.ready_at = time.monotonic() + SETTLE
            if self.fd is not None:
                fcntl.flock(self.fd, fcntl.LOCK_UN)

    def read_edid(self):
        def fn():
            os.write(self.fd, b'\x00')
            return os.read(self.fd, 128)
        try:
            data = self._transaction(EDID_ADDR, fn)
        except OSError:
            return None
        return data if len(data) == 128 and data[:8] == EDID_HEADER else None

    def get_vcp(self, code):
        """Returns (current, maximum), or None if the monitor doesn't support the code."""
        req = bytes([HOST, 0x82, OP_GET, code])
        req += bytes([checksum(req, DISPLAY)])
        error = None
        nacks = 0
        for attempt in range(ATTEMPTS):
            def fn():
                os.write(self.fd, req)
                time.sleep(REPLY_DELAY * (attempt + 1))
                return os.read(self.fd, 11)
            try:
                reply = self._transaction(DDC_ADDR, fn)
            except OSError as e:
                nacks += e.errno in NACK
                if nacks >= 2:
                    # Nobody acknowledges the DDC/CI address; more retries won't change that.
                    raise NoDdc(f'no DDC/CI reply on i2c-{self.num} ({e.strerror})')
                error = e
                continue
            try:
                return self._parse_get_reply(reply, code)
            except DdcError as e:
                error = e
                self.ready_at += SETTLE * (attempt + 1)
        raise DdcError(f'VCP 0x{code:02x} read failed on i2c-{self.num}: {error}')

    @staticmethod
    def _parse_get_reply(r, code):
        if len(r) < 3 or r[0] != DISPLAY:
            raise DdcError(f'bad reply {r.hex()}')
        length = r[1] & 0x7F
        if not r[1] & 0x80 or length == 0:
            raise DdcError('null reply (display busy)')
        if length != 8 or len(r) < 11:
            raise DdcError(f'unexpected reply length {length}')
        if checksum(r[:10], REPLY_SEED) != r[10]:
            raise DdcError(f'checksum mismatch in {r.hex()}')
        if r[2] != OP_GET_REPLY or r[4] != code:
            raise DdcError(f'reply for another request {r.hex()}')
        if r[3] != 0:
            return None
        return (r[8] << 8 | r[9], r[6] << 8 | r[7])

    def set_vcp(self, code, value):
        msg = bytes([HOST, 0x84, OP_SET, code, (value >> 8) & 0xFF, value & 0xFF])
        msg += bytes([checksum(msg, DISPLAY)])
        error = None
        for _ in range(ATTEMPTS):
            try:
                # No read-back verification: that would double the I2C traffic.
                self._transaction(DDC_ADDR, lambda: os.write(self.fd, msg))
                return
            except OSError as e:
                error = e
        raise DdcError(f'VCP 0x{code:02x} write failed on i2c-{self.num}: {error}')


def read_file(path, binary=False):
    try:
        with open(path, 'rb' if binary else 'r') as f:
            return f.read() if binary else f.read().strip()
    except OSError:
        return b'' if binary else ''


def edid_name(edid):
    """Monitor name, serial and vendor from the EDID descriptor blocks."""
    name = serial = None
    for off in (54, 72, 90, 108):
        block = edid[off:off + 18]
        if block[:3] != b'\x00\x00\x00':
            continue
        text = block[5:].split(b'\n')[0].decode('ascii', 'replace').strip()
        if block[3] == 0xFC and text:
            name = text
        elif block[3] == 0xFF and text:
            serial = text
    raw = edid[8] << 8 | edid[9]
    vendor = ''.join(chr(((raw >> s) & 0x1F) + 64) for s in (10, 5, 0))
    product = edid[10] | edid[11] << 8
    return name or f'{vendor} {product:04X}', serial, vendor


def connected_outputs():
    outputs = []
    for path in sorted(glob.glob('/sys/class/drm/card*-*')):
        card, connector = os.path.basename(path).split('-', 1)
        if connector.startswith(INTERNAL_PANELS) or read_file(f'{path}/status') != 'connected':
            continue
        edid = read_file(f'{path}/edid', binary=True)
        if len(edid) < 128 or edid[:8] != EDID_HEADER:
            continue
        outputs.append({'card': card, 'connector': connector, 'path': path, 'edid': edid[:128]})
    return outputs


def linked_bus(path):
    """The connector's own DDC bus, when the driver links it in sysfs (Intel, AMD, ...)."""
    try:
        return int(os.path.basename(os.readlink(f'{path}/ddc')).split('-')[1])
    except (OSError, IndexError, ValueError):
        pass
    for entry in os.listdir(path):
        if entry.startswith('i2c-') and entry[4:].isdigit():
            return int(entry[4:])
    return None


def gpu_buses(card):
    """I2C adapters registered by the GPU behind `card` (never SMBus or other adapters)."""
    gpu = os.path.realpath(f'/sys/class/drm/{card}/device')
    buses = []
    for path in glob.glob('/sys/bus/i2c/devices/i2c-*'):
        if os.path.realpath(path).startswith(gpu + os.sep):
            buses.append(int(path.rsplit('-', 1)[1]))
    return sorted(buses)


class Display:
    def __init__(self, key, output, bus):
        self.key = key
        self.connector = output['connector']
        self.bus = bus
        self.name, self.serial, self.vendor = edid_name(output['edid'])
        self.values = {}
        self.error = None
        self.read_at = 0.0

    def to_json(self):
        return {
            'key': self.key,
            'connector': self.connector,
            'bus': self.bus.num,
            'name': self.name,
            'serial': self.serial,
            'vendor': self.vendor,
            'values': {str(c): list(v) for c, v in self.values.items()},
            'error': self.error,
        }


class Helper:
    def __init__(self):
        self.buses = {}
        self.port_bus = {}      # (card, connector) -> bus number, learned by EDID matching
        self.displays = {}      # key -> Display
        self.probed_at = {}     # bus number -> last unanswered EDID probe time

    def bus(self, num):
        if num not in self.buses:
            self.buses[num] = Bus(num)
        return self.buses[num]

    def _probe(self, outputs, taken):
        """Finds the buses of `outputs` by reading EDIDs over I2C (drivers without sysfs links)."""
        wanted = {o['edid']: o for o in outputs}
        now = time.monotonic()
        for card in sorted({o['card'] for o in outputs}):
            for num in gpu_buses(card):
                if not wanted:
                    return
                if num in taken or now - self.probed_at.get(num, -1e9) < PROBE_RETRY_AFTER:
                    continue
                edid = self.bus(num).read_edid()
                output = wanted.pop(edid, None) if edid else None
                if output:
                    self.port_bus[(output['card'], output['connector'])] = num
                    taken.add(num)
                else:
                    self.probed_at[num] = now

    def _read(self, display, codes):
        values = {}
        try:
            for code in codes:
                value = display.bus.get_vcp(code)
                if DEBUG:
                    log(f'{display.name}: read 0x{code:02x} = {value}')
                if value is not None:
                    values[code] = value
            display.error = None if values else 'No supported controls'
        except NoDdc as e:
            display.error = 'DDC/CI unavailable'
            log(f'{display.name}: {e}')
        except (DdcError, OSError) as e:
            display.error = 'DDC/CI unavailable' if not values else None
            log(f'{display.name}: {e}')
        display.values.update(values)
        display.read_at = time.monotonic()

    def detect(self, force=False, codes=DEFAULT_CODES):
        outputs = connected_outputs()
        found, unmapped = {}, []
        for o in outputs:
            key = f"{o['connector']}/{hashlib.sha1(o['edid']).hexdigest()[:12]}"
            o['key'] = key
            if key in self.displays:
                found[key] = self.displays[key]
                continue
            num = linked_bus(o['path'])
            if num is None:
                num = self.port_bus.get((o['card'], o['connector']))
            if num is None:
                unmapped.append(o)
            else:
                found[key] = Display(key, o, self.bus(num))
        if unmapped:
            if force:
                self.probed_at.clear()
            self._probe(unmapped, {d.bus.num for d in found.values()})
            for o in unmapped:
                num = self.port_bus.get((o['card'], o['connector']))
                if num is not None:
                    found[o['key']] = Display(o['key'], o, self.bus(num))
        self.displays = found
        now = time.monotonic()
        for d in found.values():
            stale_failure = d.error and now - d.read_at > FAILED_RETRY_AFTER
            if force or not d.read_at or stale_failure:
                self._read(d, codes)
        return self._state(outputs)

    def _state(self, outputs):
        issue = None
        if not glob.glob('/dev/i2c-*'):
            issue = 'no-i2c-dev'
        elif not any(os.access(p, os.R_OK | os.W_OK) for p in glob.glob('/dev/i2c-*')):
            issue = 'no-permission'
        elif outputs and not self.displays:
            issue = 'no-bus'
        return {'displays': [d.to_json() for d in self.displays.values()], 'issue': issue}

    def set(self, key, code, value):
        d = self.displays.get(key)
        if not d:
            return
        if DEBUG:
            log(f'{d.name}: write 0x{code:02x} = {value}')
        try:
            d.bus.set_vcp(code, value)
        except (DdcError, OSError) as e:
            log(f'{d.name}: {e}')
            return
        if code in d.values:
            d.values[code] = (value, d.values[code][1])

    def handle(self, req):
        op = req.get('op')
        if op == 'set':
            self.set(req['key'], int(req['code']), int(req['value']))
            return None
        if op == 'detect':
            return self.detect()
        if op == 'refresh':
            return self.detect(force=True)
        raise ValueError(f'unknown op {op!r}')


def enqueue(queue, req):
    """Coalesces a write with an already queued write to the same display feature."""
    if req.get('op') == 'set':
        for pending in queue:
            if pending.get('op') == 'set' and pending['key'] == req['key'] and pending['code'] == req['code']:
                pending['value'] = req['value']
                return
    queue.append(req)


def main():
    helper = Helper()
    stdin = sys.stdin.fileno()
    buf = b''
    queue = []
    eof = False
    while queue or not eof:
        # Drain everything already written to us before doing slow I2C work, so a burst
        # of slider updates collapses into a single write.
        readable = []
        if not eof:
            readable, _, _ = select.select([stdin], [], [], 0 if queue else None)
        if readable:
            chunk = os.read(stdin, 65536)
            if not chunk:
                eof = True
            buf += chunk
            *lines, buf = buf.split(b'\n')
            for line in lines:
                if not line.strip():
                    continue
                try:
                    req = json.loads(line)
                    if not isinstance(req, dict) or (req.get('op') == 'set' and
                                                     not {'key', 'code', 'value'} <= req.keys()):
                        raise ValueError('malformed')
                    enqueue(queue, req)
                except ValueError as e:
                    log(f'bad request {line[:80]!r}: {e}')
            continue
        req = queue.pop(0)
        try:
            reply = helper.handle(req)
        except Exception as e:  # never die on one bad request
            log(f'{req.get("op")}: {e!r}')
            reply = {'error': str(e)}
        if reply is not None and 'id' in req:
            reply['id'] = req['id']
            sys.stdout.write(json.dumps(reply) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
