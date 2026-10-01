import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/** Row that records a key combination when clicked (Backspace clears, Escape cancels). */
function shortcutRow(settings, key, title) {
    const row = new Adw.ActionRow({title, activatable: true});
    const label = new Gtk.ShortcutLabel({
        disabled_text: _('Disabled'),
        valign: Gtk.Align.CENTER,
    });
    row.add_suffix(label);

    const sync = () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    settings.connect(`changed::${key}`, sync);

    row.connect('activated', () => {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: _('Press a key combination, Backspace to disable, or Escape to cancel.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (!mods && keyval === 0xff1b /* Escape */) {
                dialog.close();
                return true;
            }
            if (!mods && keyval === 0xff08 /* BackSpace */) {
                settings.set_strv(key, []);
                dialog.close();
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mods))
                return true;
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
            dialog.close();
            return true;
        });
        dialog.add_controller(controller);
        dialog.present(row.get_root());
    });
    return row;
}

const UPDATE_RATES = [100, 250, 500, 1000];

/** Twinkle Tray's "update rate": how often a monitor is written to while a slider moves. */
function updateRateRow(settings) {
    const row = new Adw.ComboRow({
        title: _('Update rate'),
        subtitle: _('How often monitors follow a moving slider'),
        model: Gtk.StringList.new([_('100 ms'), _('250 ms'), _('500 ms'), _('1 s')]),
    });
    const sync = () => {
        const index = UPDATE_RATES.indexOf(settings.get_int('update-interval'));
        row.selected = index >= 0 ? index : 1;
    };
    sync();
    settings.connect('changed::update-interval', sync);
    row.connect('notify::selected', () => {
        const rate = UPDATE_RATES[row.selected];
        if (rate && rate !== settings.get_int('update-interval'))
            settings.set_int('update-interval', rate);
    });
    return row;
}

export default class TwinkleTrayPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const general = new Adw.PreferencesGroup({title: _('General')});
        page.add(general);

        const link = new Adw.SwitchRow({
            title: _('Link levels'),
            subtitle: _('Moving one monitor\'s brightness moves all of them'),
        });
        settings.bind('link-levels', link, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(link);

        const contrast = new Adw.SwitchRow({title: _('Show contrast sliders')});
        settings.bind('show-contrast', contrast, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(contrast);

        general.add(updateRateRow(settings));

        const step = new Adw.SpinRow({
            title: _('Brightness step'),
            subtitle: _('Percent per scroll on the panel icon or per shortcut press'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 50, step_increment: 1}),
        });
        settings.bind('step', step, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(step);

        const delay = new Adw.SpinRow({
            title: _('Turn-off delay (ms)'),
            subtitle: _('Wait before blanking so releasing the mouse/keys doesn\'t wake the displays'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 5000, step_increment: 100}),
        });
        settings.bind('turn-off-delay', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(delay);

        const keys = new Adw.PreferencesGroup({title: _('Keyboard shortcuts')});
        page.add(keys);
        keys.add(shortcutRow(settings, 'shortcut-turn-off', _('Turn off displays')));
        keys.add(shortcutRow(settings, 'shortcut-brightness-up', _('Increase brightness')));
        keys.add(shortcutRow(settings, 'shortcut-brightness-down', _('Decrease brightness')));
    }
}
