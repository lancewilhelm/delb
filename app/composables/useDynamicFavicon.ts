import themeList from "@/assets/json/themes.json";
import { useUserSettingsStore } from "@/stores/userSettings";

export function useDynamicFavicon() {
  const userSettings = useUserSettingsStore();
  const route = useRoute();

  return computed(() => {
    const themeName =
      userSettings.settings.theme &&
      route.path !== "/login" &&
      route.path !== "/register"
        ? userSettings.settings.theme
        : "guage";

    const theme = themeList.find((t) => t.name === themeName);
    const mainColor = theme?.mainColor || "#dddddd";
    const bgColor = theme?.bgColor || "#1b1b1b";

    const svg = `
      <svg width="100%" height="100%" viewBox="0 0 250 250" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" xmlns:serif="http://www.serif.com/" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
        <style>
          #bg {
            fill: ${bgColor};
          }
          #fg {
            fill: ${mainColor};
          }
        </style>
        <g id="bg" transform="matrix(1.07238,0,0,1.07238,-11.6867,-8.81532)">
          <path d="M244.024,55.41L244.024,194.157C244.024,220.202 222.879,241.347 196.835,241.347L58.087,241.347C32.043,241.347 10.898,220.202 10.898,194.157L10.898,55.41C10.898,29.365 32.043,8.22 58.087,8.22L196.835,8.22C222.879,8.22 244.024,29.365 244.024,55.41Z"/>
        </g>
        <g id="fg" transform="matrix(0.98614,0,0,0.98614,2.47205,38.7127)">
          <g id="fg1" serif:id="fg">
            <circle id="circle" cx="124.5" cy="88" r="35"/>
            <path id="left-bracket" d="M98.835,9L72.956,9C72.351,9 71.779,9.273 71.4,9.743L10.009,85.751C9.419,86.481 9.416,87.522 10.001,88.255L71.4,165.247C71.779,165.723 72.355,166 72.963,166L98.868,166C100.539,166 101.473,164.07 100.436,162.759L41.488,88.249C40.91,87.518 40.913,86.485 41.496,85.757L100.395,12.251C101.444,10.941 100.512,9 98.835,9Z"/>
            <path id="right-bracket" d="M149.665,166L175.544,166C176.149,166 176.721,165.727 177.1,165.257L238.491,89.249C239.081,88.519 239.084,87.478 238.499,86.745L177.101,9.753C176.721,9.277 176.146,9 175.537,9L149.632,9C147.961,9 147.027,10.93 148.064,12.241L207.012,86.751C207.59,87.482 207.587,88.515 207.004,89.243L148.105,162.749C147.056,164.059 147.988,166 149.665,166Z"/>
          </g>
        </g>
      </svg>
    `;

    return `data:image/svg+xml;base64,${btoa(svg)}`;
  });
}
