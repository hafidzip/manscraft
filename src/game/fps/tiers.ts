
export const SIM_RADIUS_EXPORTED = 112;

export type Tier = 0 | 1 | 2 | 3;
export const TIER_HOT     = 0 as Tier;
export const TIER_WARM    = 1 as Tier;
export const TIER_COLD    = 2 as Tier;
export const TIER_DORMANT = 3 as Tier;

export const TIER_PERIOD_S: [number, number, number, number] = [0, 1 / 15, 1 / 4, 1 / 1.3];

export const MAX_TICK_DT  = 1 / 15;
export const MAX_SUBSTEPS = 4;

export const RENDER_BUDGET = 140;
export const HOT_BUDGET    = 96;
export const WARM_BUDGET   = 320;
export const COLD_BUDGET   = 900;

export const RENDER_R = 80;
export const HOT_R    = 40;
export const WARM_R   = 72;
export const COLD_R   = 112;

export const TIER_HYST           = 1.12;
export const DORMANT_SPEED_SCALE = 0.6;

export const MAX_POP_R = 220;
