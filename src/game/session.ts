/**
 * App-wide session flags that survive React remounts (planet ↔ space swaps
 * remount both canvases, but the *session* continues).
 *
 * `booted` flips the first time the player takes control. The unified title
 * screen only shows before that moment — every later planet/space entry drops
 * straight into the action with no title screen and no loading cut.
 */
export const session = {
  booted: false,
};
