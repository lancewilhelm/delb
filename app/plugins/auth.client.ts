export default defineNuxtPlugin({
  name: 'delb-auth-init',
  enforce: 'pre',
  async setup() {
    await useAuth().fetchSession();
  },
});
