import { fontFamilyOptions } from './fontFamilies';

/**
 * Builds the synchronous inline `<head>` script that applies persisted theme
 * and font preferences from `localStorage` before first paint in SPA mode.
 *
 * The generated script runs independently of the app bundle.
 */
export function buildSpaBootScript(): string {
  return `(() => {
  try {
    var safeTheme = /^[a-zA-Z0-9_-]+$/;
    var hex6 = /^#[\\da-f]{6}$/i;
    var hex3 = /^#[\\da-f]{3}$/i;
    var mobileRe = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i;
    var defaults = { mode: 'system', fixed: 'guage_light', light: 'guage_light', dark: 'guage_dark' };
    var defaultCustom = {
      bgColor: '#dddddd',
      textColor: '#1b1b1b',
      mainColor: '#1b1b1b',
      subColor: '#555555',
      subAltColor: '#cccccc',
      errorColor: '#883333'
    };
    var allowedFonts = ${JSON.stringify(fontFamilyOptions)};
    var parsed = null;
    try {
      var raw = localStorage.getItem('delb.userSettings');
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_parseErr) {
      parsed = null;
    }
    var base = parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
      ? parsed.settings
      : {};
    var isMobile = typeof navigator !== 'undefined' && mobileRe.test(navigator.userAgent || '');
    var active = (isMobile && base.mobile && base.mobile.enabled && base.mobile.settings && typeof base.mobile.settings === 'object')
      ? Object.assign({}, base, base.mobile.settings)
      : base;

    var pref = defaults;
    if (typeof active.theme === 'string' && safeTheme.test(active.theme) && !active.themePreference) {
      pref = Object.assign({}, defaults, { mode: 'fixed', fixed: active.theme });
    } else if (active.themePreference && typeof active.themePreference === 'object') {
      var tp = active.themePreference;
      pref = {
        mode: tp.mode === 'fixed' ? 'fixed' : 'system',
        fixed: typeof tp.fixed === 'string' && safeTheme.test(tp.fixed) ? tp.fixed : defaults.fixed,
        light: typeof tp.light === 'string' && safeTheme.test(tp.light) ? tp.light : defaults.light,
        dark: typeof tp.dark === 'string' && safeTheme.test(tp.dark) ? tp.dark : defaults.dark
      };
    }

    var isDark = typeof matchMedia === 'function'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : false;
    var theme = pref.mode === 'fixed' ? pref.fixed : (isDark ? pref.dark : pref.light);

    var normHex = function (v, fb) {
      if (typeof v !== 'string') return fb;
      var s = v.trim();
      if (hex6.test(s)) return s.toLowerCase();
      if (hex3.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
      return fb;
    };

    var head = document.head;
    if (head) {
      var existingTheme = document.getElementById('currentTheme');
      if (existingTheme) existingTheme.remove();
      if (theme === 'custom') {
        var src = active.customTheme && typeof active.customTheme === 'object' ? active.customTheme : {};
        var bg = normHex(src.bgColor, defaultCustom.bgColor);
        var text = normHex(src.textColor, defaultCustom.textColor);
        var main = normHex(src.mainColor, defaultCustom.mainColor);
        var sub = normHex(src.subColor, defaultCustom.subColor);
        var subAlt = normHex(src.subAltColor, defaultCustom.subAltColor);
        var err = normHex(src.errorColor, defaultCustom.errorColor);
        var styleEl = document.createElement('style');
        styleEl.id = 'currentTheme';
        styleEl.textContent = ':root{--bg-color:' + bg + ';--text-color:' + text + ';--main-color:' + main + ';--sub-color:' + sub + ';--sub-alt-color:' + subAlt + ';--error-color:' + err + ';--caret-color:' + main + ';--error-extra-color:' + err + ';--colorful-error-color:' + err + ';--colorful-error-extra-color:' + err + ';}';
        head.appendChild(styleEl);
      } else {
        var linkEl = document.createElement('link');
        linkEl.id = 'currentTheme';
        linkEl.rel = 'stylesheet';
        linkEl.href = '/css/themes/' + theme + '.css';
        head.appendChild(linkEl);
      }

      var pathname = typeof location !== 'undefined' ? location.pathname : '';
      var isAuthRoute = pathname === '/login' || pathname === '/register';
      var font = !isAuthRoute && allowedFonts.includes(active.fontFamily)
        ? active.fontFamily
        : 'Geist, sans-serif';
      var existingFont = document.getElementById('currentFontFamilyStyle');
      if (existingFont) existingFont.remove();
      var fontEl = document.createElement('style');
      fontEl.id = 'currentFontFamilyStyle';
      fontEl.textContent = 'body, html { font-family: ' + font + ' !important; }';
      head.appendChild(fontEl);
    }
  } catch (_e) {}
})();`;
}
