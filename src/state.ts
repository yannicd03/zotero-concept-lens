/** Run state of the plugin. */
export const state = {
  /** Startup has finished. */
  initialized: false,
  /** Set to false on shutdown. */
  alive: true,
  env: __env__,
};
