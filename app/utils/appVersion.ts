export const appVersion: string =
  typeof __DELB_APP_VERSION__ === 'string' && __DELB_APP_VERSION__
    ? __DELB_APP_VERSION__
    : 'unknown';
