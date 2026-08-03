/**
 * Adjust these to change difficulty/spread.
 */
export const CAMP_CONFIG = {
  campCount: 5,            // how many camps per world
  minDistFromSpawn: 40,    // blocks from spawn
  squadSize: [3, 5] as [number, number], // min..max enemies per camp
  respawnDelay: 20,        // seconds before a dead camper respawns
  repopulateDelay: 90,     // seconds before a CLEARED camp repopulates (0 = never)
  patrolSpeedFactor: 0.55, // patrol walk speed multiplier
  maxLeash: 70,            // aggro leash radius from camp center
};

export type { CampSite, CampBuild } from '../world/camps';
