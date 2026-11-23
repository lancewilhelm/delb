import { addCollection, addIcon } from '@iconify/vue';
import { lucideCollection } from 'virtual:delb-icons';
import { extraIcons } from './extraIcons';

let registered = false;

export function registerIcons() {
  if (registered) return;
  registered = true;
  addCollection(lucideCollection);
  for (const [name, data] of Object.entries(extraIcons)) {
    addIcon(name, data);
  }
}
