import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {VCP_BRIGHTNESS, VCP_CONTRAST} from './ddc.js';

// Secondary text is dimmed with opacity so it works on both the light and dark shell themes.
const DIM = 160;
const BRIGHTNESS_ICON = Gio.ThemedIcon.new('display-brightness-symbolic');

function describeIssue(issue) {
    switch (issue) {
    case 'no-python':
        return [_('Python 3 is required'), _('Install the python3 package')];
    case 'no-i2c-dev':
        return [_('I²C is not available'), _('Load the i2c-dev kernel module: sudo modprobe i2c-dev')];
    case 'no-permission':
        return [_('No access to /dev/i2c-*'), _('Add yourself to the “i2c” group, then log in again')];
    case 'no-bus':
        return [_('Can’t reach the monitors'), _('Their DDC/CI channel wasn’t found')];
    case 'helper-failed':
        return [_('Monitor control stopped'), _('It restarts automatically in a few seconds')];
    default:
        return null;
    }
}

export function showBrightnessOsd(level) {
    if (level !== null)
        Main.osdWindowManager.showAll(BRIGHTNESS_ICON, null, level, 1);
}

/** "icon — slider — 42" row bound to one VCP feature of one monitor. */
const VcpSliderItem = GObject.registerClass(
class VcpSliderItem extends PopupMenu.PopupBaseMenuItem {
    _init(monitor, code, gicon, label, onUserChange) {
        super._init({activate: false, style_class: 'twinkle-slider-item'});
        this.monitor = monitor;
        this.code = code;
        this._updating = false;
        this._dragging = false;

        this.add_child(new St.Icon({gicon, style_class: 'popup-menu-icon'}));
        this._slider = new Slider(0);
        this._slider.x_expand = true;
        this._slider.accessible_name = `${monitor.name} ${label}`;
        this._slider.connect('drag-begin', () => (this._dragging = true));
        this._slider.connect('drag-end', () => (this._dragging = false));
        this._slider.connect('notify::value', () => {
            this._syncLabel();
            if (!this._updating)
                onUserChange(this, this._slider.value);
        });
        this.add_child(this._slider);
        this._label = new St.Label({style_class: 'twinkle-value', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);
        this.sync();
    }

    _syncLabel() {
        this._label.text = String(Math.round(this._slider.value * 100));
    }

    /** Moves the slider without writing to the monitor. */
    setValue(fraction) {
        this._updating = true;
        this._slider.value = fraction;
        this._updating = false;
        this._syncLabel();
    }

    sync() {
        const value = this.monitor.getPercent(this.code);
        if (value !== null && !this._dragging)
            this.setValue(value);
    }

    vfunc_key_press_event(event) {
        // Left/Right on the focused row move the slider, like in Quick Settings.
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Left || key === Clutter.KEY_Right)
            return this._slider.vfunc_key_press_event(event);
        return super.vfunc_key_press_event(event);
    }
});

function headerRow(iconName, title, detail, styleClass) {
    const box = new St.BoxLayout({style_class: styleClass});
    box.add_child(new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER}));
    const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    text.add_child(new St.Label({text: title, style_class: 'twinkle-row-title'}));
    if (detail) {
        const label = new St.Label({text: detail, style_class: 'twinkle-row-detail', opacity: DIM});
        label.clutter_text.line_wrap = true;
        text.add_child(label);
    }
    box.add_child(text);
    return box;
}

export const TwinkleIndicator = GObject.registerClass(
class TwinkleIndicator extends PanelMenu.Button {
    _init(ext, store) {
        super._init(0.5, _('Displays'));
        this._ext = ext;
        this._store = store;
        this._settings = ext.getSettings();
        this._rows = [];
        this._contrastIcon = Gio.FileIcon.new(ext.dir.resolve_relative_path('icons/contrast-symbolic.svg'));

        this.add_child(new St.Icon({icon_name: 'display-brightness-symbolic', style_class: 'system-status-icon'}));
        this.menu.box.add_style_class_name('twinkle-menu');

        this.menu.box.add_child(this._buildHeader());
        this._monitorSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._monitorSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._linkItem = new PopupMenu.PopupSwitchMenuItem(_('Link levels'), this._settings.get_boolean('link-levels'));
        this._linkItem.connect('toggled', (_item, state) => this._settings.set_boolean('link-levels', state));
        this.menu.addMenuItem(this._linkItem);

        const offItem = new PopupMenu.PopupImageMenuItem(_('Turn off displays'), 'system-shutdown-symbolic');
        offItem.connect('activate', () => ext.turnOffDisplays());
        this.menu.addMenuItem(offItem);

        store.connectObject(
            'changed', () => this._rebuild(),
            'values-changed', () => this._sync(),
            this);
        this._settings.connectObject(
            'changed::link-levels', () => this._linkItem.setToggleState(this._settings.get_boolean('link-levels')),
            'changed::show-contrast', () => this._rebuild(),
            this);
        this.menu.connect('open-state-changed', (_menu, open) => {
            // Values are cached; a stale re-read happens after closing, never while open.
            if (!open)
                store.refreshIfStale();
        });
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this._rebuild();
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'twinkle-header'});
        header.add_child(new St.Label({
            text: _('Displays'),
            style_class: 'twinkle-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._refreshButton = this._headerButton('view-refresh-symbolic', _('Refresh monitors'), async () => {
            this._refreshButton.reactive = false;
            try {
                await this._store.detect({refresh: true});
            } finally {
                this._refreshButton.reactive = true;
            }
        });
        header.add_child(this._refreshButton);
        header.add_child(this._headerButton('preferences-system-symbolic', _('Settings'), () => {
            this.menu.close();
            this._ext.openPreferences();
        }));
        return header;
    }

    _headerButton(iconName, accessibleName, onClick) {
        const button = new St.Button({
            style_class: 'icon-button twinkle-header-button',
            icon_name: iconName,
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    _rebuild() {
        // Header rows are plain actors, which removeAll() would leave behind.
        this._monitorSection.box.destroy_all_children();
        this._rows = [];
        const store = this._store;
        const monitors = store.monitors;

        if (!monitors.length) {
            let title, detail, icon = 'dialog-information-symbolic';
            const issue = describeIssue(store.issue);
            if (issue) {
                [title, detail] = issue;
                icon = 'dialog-warning-symbolic';
            } else if (store.detecting) {
                title = _('Looking for monitors…');
            } else {
                title = _('No external monitors found');
                detail = _('Monitors need DDC/CI, which may have to be enabled in their on-screen menu');
            }
            this._monitorSection.box.add_child(headerRow(icon, title, detail, 'twinkle-message'));
        }

        const showContrast = this._settings.get_boolean('show-contrast');
        monitors.forEach((monitor, i) => {
            if (i > 0)
                this._monitorSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const detail = monitor.error && !monitor.has(VCP_BRIGHTNESS)
                ? `${monitor.connector} · ${monitor.error}` : monitor.connector;
            this._monitorSection.box.add_child(
                headerRow('video-display-symbolic', monitor.name, detail, 'twinkle-monitor-header'));
            if (monitor.has(VCP_BRIGHTNESS)) {
                this._addRow(new VcpSliderItem(monitor, VCP_BRIGHTNESS, BRIGHTNESS_ICON, _('brightness'),
                    (row, value) => this._onSliderChanged(row, value)));
            }
            if (showContrast && monitor.has(VCP_CONTRAST)) {
                this._addRow(new VcpSliderItem(monitor, VCP_CONTRAST, this._contrastIcon, _('contrast'),
                    (row, value) => this._onSliderChanged(row, value)));
            }
        });

        this._linkItem.visible = store.controllable.length > 1;
    }

    _addRow(row) {
        this._monitorSection.addMenuItem(row);
        this._rows.push(row);
    }

    _onSliderChanged(row, value) {
        row.monitor.setPercent(row.code, value);
        if (row.code !== VCP_BRIGHTNESS || !this._settings.get_boolean('link-levels'))
            return;
        for (const other of this._rows) {
            if (other !== row && other.code === VCP_BRIGHTNESS) {
                other.monitor.setPercent(VCP_BRIGHTNESS, value);
                other.setValue(value);
            }
        }
    }

    _sync() {
        for (const row of this._rows)
            row.sync();
    }

    _onScroll(event) {
        // A wheel notch arrives twice: as a discrete event and as an emulated smooth one.
        if (event.is_pointer_emulated())
            return Clutter.EVENT_STOP;
        const step = this._settings.get_int('step') / 100;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = step;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -step;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            // Touchpads send many tiny deltas; act once per "notch" worth of movement.
            const [, dy] = event.get_scroll_delta();
            this._smoothScroll = (this._smoothScroll ?? 0) + dy;
            if (Math.abs(this._smoothScroll) < 1)
                return Clutter.EVENT_STOP;
            delta = -Math.sign(this._smoothScroll) * step;
            this._smoothScroll = 0;
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        showBrightnessOsd(this._store.adjustBrightness(delta));
        return Clutter.EVENT_STOP;
    }
});
