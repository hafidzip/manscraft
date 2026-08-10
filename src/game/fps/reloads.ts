import { TimelineDef, Key } from './anim';
import { deg } from './anim';

export interface ReloadCtx {
  hideMag(): void;
  showMag(): void;
  showMagHand(): void;
  hideMagHand(): void;
  dropMag(): void;
  showWarhead(): void;
  hideWarheadHand(): void;
  showWarheadHand(): void;
  ejectShell(): void;
  sfx(name: 'out' | 'in' | 'rack' | 'snap' | 'slap' | 'grab' | 'twist'): void;
}

type Ctx = ReloadCtx;

const k = (t: number, p?: [number, number, number], r?: [number, number, number], e: Key['e'] = 'smooth'): Key => ({ t, p, r, e });

const MAG_REST: Record<string, { p: [number, number, number]; r: [number, number, number] }> = {
  handgun: { p: [0, -0.09, 0.052], r: [deg(-14), 0, 0] },
  smg: { p: [0, -0.055, -0.1], r: [0, 0, 0] },
  rifle: { p: [0, -0.05, -0.03], r: [0, 0, 0] },
  sniper: { p: [0, -0.055, -0.02], r: [0, 0, 0] },
};

function handgun(ctx: Ctx): TimelineDef {
  const rest = MAG_REST.handgun;
  const SEAT = 1.18;
  return {
    duration: 2.0,
    tracks: [
      { node: 'gun', keys: [
        k(0.0, [0, 0, 0], [0, 0, 0]),
        k(0.16, [-0.02, 0.04, 0.03], [deg(18), deg(22), deg(42)], 'out'),
        k(0.48, [-0.02, 0.042, 0.03], [deg(18), deg(22), deg(42)], 'smooth'),
        k(0.96, [-0.02, 0.042, 0.03], [deg(18), deg(22), deg(42)], 'smooth'),
        k(1.22, [-0.015, 0.01, 0.025], [deg(10), deg(12), deg(28)], 'out'),
        k(1.36, [-0.01, 0.005, 0.02], [deg(8), deg(8), deg(18)], 'smooth'),
        k(1.52, [0.01, 0.015, 0.005], [deg(-4), deg(3), deg(8)], 'out'),
        k(1.72, [0.005, 0.005, 0.0], [deg(-2), deg(2), deg(4)], 'smooth'),
        k(1.95, [0, 0, 0], [0, 0, 0], 'inout'),
      ]},

      { node: 'mag', keys: [
        k(0.0, rest.p, rest.r),
        k(0.22, [0, -0.092, 0.052], [deg(-14), deg(2), 0], 'out'),
        k(0.35, [0, -0.098, 0.054], [deg(-16), deg(-3), 0], 'snap'),
        k(0.44, [0, -0.16, 0.06], [deg(-28), deg(-5), deg(4)], 'in'),
        k(0.56, [0, -0.34, 0.07], [deg(-55), deg(-8), deg(12)], 'in'),
        k(SEAT - 0.02, [0, -0.34, 0.07], [deg(-55), deg(-8), deg(12)], 'linear'),
        k(SEAT - 0.01, [0, -0.095, 0.052], [deg(-14), 0, 0], 'linear'),
        k(1.34, rest.p, rest.r, 'out'),
      ]},

      { node: 'maghand', keys: [
        k(0.6, [0, -0.42, 0.055], [deg(-14), 0, deg(6)]),
        k(0.82, [0, -0.25, 0.052], [deg(-14), 0, deg(3)], 'out'),
        k(1.02, [0, -0.14, 0.052], [deg(-14), 0, 0], 'out'),
        k(SEAT, [0, -0.095, 0.052], [deg(-14), 0, 0], 'snap'),
      ]},

      { node: 'lhand', keys: [
        k(0.0, [-0.01, -0.095, 0.058], [deg(-30), deg(8), deg(6)]),
        k(0.2, [-0.01, -0.14, 0.06], [deg(-50), deg(6), deg(4)], 'out'),
        k(0.42, [-0.03, -0.25, 0.065], [deg(-65), deg(5), deg(8)], 'smooth'),
        k(0.58, [-0.04, -0.38, 0.08], [deg(-72), deg(4), deg(12)], 'in'),
        k(0.82, [-0.02, -0.24, 0.058], [deg(-60), 0, deg(4)], 'out'),
        k(1.0, [-0.01, -0.16, 0.054], [deg(-50), 0, deg(2)], 'out'),
        k(1.15, [-0.01, -0.10, 0.056], [deg(-35), 0, 0], 'snap'),
        k(1.22, [-0.005, -0.065, 0.054], [deg(-30), 0, deg(-4)], 'snap'),
        k(1.32, [-0.005, -0.055, 0.060], [deg(-28), 0, deg(-6)], 'snap'),
        k(1.42, [0.008, 0.04, 0.095], [deg(-12), 0, deg(-22)], 'smooth'),
        k(1.52, [0.008, 0.042, 0.058], [deg(-12), 0, deg(-22)], 'snap'),
        k(1.62, [0.005, 0.05, 0.10], [deg(-10), 0, deg(-18)], 'out'),
        k(1.82, [-0.005, -0.04, 0.068], [deg(-20), deg(4), deg(2)], 'smooth'),
        k(1.97, [-0.01, -0.095, 0.058], [deg(-30), deg(8), deg(6)], 'inout'),
      ]},

      { node: 'rhand', keys: [
        k(0.0, [0, -0.062, 0.055], [deg(-14), 0, 0]),
        k(0.16, [0.01, -0.055, 0.058], [deg(-12), deg(-3), deg(2)], 'out'),
        k(1.3, [0.01, -0.055, 0.058], [deg(-12), deg(-3), deg(2)], 'smooth'),
        k(1.55, [0.005, -0.058, 0.056], [deg(-14), deg(-1), deg(1)], 'out'),
        k(1.95, [0, -0.062, 0.055], [deg(-14), 0, 0], 'inout'),
      ]},

      { node: 'slide', keys: [
        k(0.0, [0, 0.032, -0.015]),
        k(1.48, [0, 0.032, -0.015]),
        k(1.54, [0, 0.032, 0.035], undefined, 'snap'),
        k(1.64, [0, 0.032, -0.015], undefined, 'snap'),
      ]},
    ],
    events: [
      { t: 0.22, fn: () => ctx.sfx('out') },
      { t: 0.56, fn: () => { ctx.hideMag(); ctx.dropMag(); } },
      { t: 0.6, fn: () => { ctx.sfx('grab'); ctx.showMagHand(); } },
      { t: SEAT, fn: () => { ctx.sfx('in'); ctx.showMag(); ctx.hideMagHand(); } },
      { t: 1.32, fn: () => ctx.sfx('slap') },
      { t: 1.54, fn: () => ctx.sfx('rack') },
      { t: 1.64, fn: () => ctx.sfx('snap') },
    ],
  };
}

function smg(ctx: Ctx): TimelineDef {
  const rest = MAG_REST.smg;
  const SEAT = 1.48;
  return {
    duration: 2.15,
    tracks: [
      { node: 'gun', keys: [
        k(0.0, [0, 0, 0], [0, 0, 0]),
        k(0.25, [0.03, 0.01, 0.02], [deg(10), deg(8), deg(32)], 'out'),
        k(1.6, [0.03, 0.01, 0.02], [deg(10), deg(8), deg(32)], 'smooth'),
        k(2.1, [0, 0, 0], [0, 0, 0], 'inout'),
      ]},
      { node: 'lhand', keys: [
        k(0.0, [0, -0.075, -0.155], [deg(-55), 0, 0]),
        k(0.3, [0, -0.16, -0.09], [deg(-75), 0, 0], 'out'),
        k(0.65, [0, -0.2, -0.05], [deg(-80), 0, 0], 'smooth'),
        k(0.85, [-0.03, -0.33, 0.0], [deg(-80), deg(10), 0], 'in'),
        k(1.1, [0, -0.22, -0.02], [deg(-70), 0, 0], 'out'),
        k(1.35, [0, -0.13, -0.06], [deg(-70), 0, 0], 'snap'),
        k(1.52, [0, -0.173, -0.09], [deg(-70), 0, 0], 'out'),
        k(1.68, [-0.05, -0.03, -0.19], [deg(-30), deg(20), deg(20)], 'smooth'),
        k(1.84, [-0.055, -0.03, -0.1], [deg(-30), deg(20), deg(20)], 'snap'),
        k(1.94, [-0.05, -0.03, -0.2], [deg(-30), deg(20), deg(20)], 'out'),
        k(2.12, [0, -0.075, -0.155], [deg(-55), 0, 0], 'inout'),
      ]},
      { node: 'mag', keys: [
        k(0.0, rest.p, rest.r),
        k(0.34, [0, -0.06, -0.1], [0, 0, 0], 'out'),
        k(0.58, [0, -0.1, -0.08], [deg(-38), 0, 0], 'in'),
        k(0.72, [0, -0.26, -0.02], [deg(-55), 0, 0], 'in'),
        k(SEAT - 0.02, [0, -0.26, -0.02], [deg(-55), 0, 0], 'linear'),
        k(SEAT - 0.01, rest.p, rest.r, 'linear'),
      ]},
      { node: 'maghand', keys: [
        k(0.9, [0, -0.34, -0.03], [0, 0, 0]),
        k(1.3, [0, -0.1, -0.05], [deg(40), 0, 0], 'out'),
        k(SEAT, rest.p, rest.r, 'snap'),
      ]},
      { node: 'handle', keys: [
        k(0.0, [-0.032, 0.02, -0.2]),
        k(1.68, [-0.032, 0.02, -0.2]),
        k(1.84, [-0.032, 0.02, -0.09], undefined, 'snap'),
        k(1.94, [-0.032, 0.02, -0.2], undefined, 'snap'),
      ]},
    ],
    events: [
      { t: 0.3, fn: () => ctx.sfx('out') },
      { t: 0.73, fn: () => { ctx.hideMag(); ctx.dropMag(); } },
      { t: 0.9, fn: () => { ctx.sfx('grab'); ctx.showMagHand(); } },
      { t: SEAT, fn: () => { ctx.sfx('in'); ctx.showMag(); ctx.hideMagHand(); } },
      { t: 1.62, fn: () => ctx.sfx('slap') },
      { t: 1.86, fn: () => ctx.sfx('rack') },
      { t: 1.94, fn: () => ctx.sfx('snap') },
    ],
  };
}

function rifle(ctx: Ctx): TimelineDef {
  const rest = MAG_REST.rifle;
  const SEAT = 1.48;
  return {
    duration: 2.3,
    tracks: [
      { node: 'gun', keys: [
        k(0.0, [0, 0, 0], [0, 0, 0]),
        k(0.25, [0.03, 0.015, 0.03], [deg(12), deg(8), deg(30)], 'out'),
        k(1.7, [0.03, 0.015, 0.03], [deg(12), deg(8), deg(30)], 'smooth'),
        k(2.25, [0, 0, 0], [0, 0, 0], 'inout'),
      ]},
      { node: 'lhand', keys: [
        k(0.0, [0, -0.05, -0.245], [deg(-75), 0, 0]),
        k(0.32, [0, -0.11, -0.04], [deg(-60), 0, 0], 'out'),
        k(0.7, [0, -0.24, 0.03], [deg(-70), 0, 0], 'smooth'),
        k(0.85, [-0.02, -0.33, 0.06], [deg(-70), 0, 0], 'in'),
        k(1.1, [0, -0.2, 0.02], [deg(-65), 0, 0], 'out'),
        k(1.35, [0, -0.13, -0.01], [deg(-65), 0, 0], 'snap'),
        k(1.5, [0, -0.17, 0.0], [deg(-65), 0, 0], 'out'),
        k(1.62, [0, -0.155, 0.0], [deg(-65), 0, 0], 'snap'),
        k(1.8, [0.005, 0.06, 0.03], [deg(-20), 0, deg(-15)], 'smooth'),
        k(1.94, [0.005, 0.06, 0.165], [deg(-20), 0, deg(-15)], 'snap'),
        k(2.04, [0.005, 0.06, 0.03], [deg(-20), 0, deg(-15)], 'out'),
        k(2.26, [0, -0.05, -0.245], [deg(-75), 0, 0], 'inout'),
      ]},
      { node: 'mag', keys: [
        k(0.0, rest.p, rest.r),
        k(0.36, [0, -0.05, -0.03], [0, 0, 0], 'smooth'),
        k(0.55, [0, -0.08, -0.05], [deg(40), 0, 0], 'in'),
        k(0.72, [0, -0.28, 0.04], [deg(55), 0, 0], 'in'),
        k(SEAT - 0.02, [0, -0.28, 0.04], [deg(55), 0, 0], 'linear'),
        k(SEAT - 0.01, rest.p, rest.r, 'linear'),
      ]},
      { node: 'maghand', keys: [
        k(0.92, [0, -0.34, 0.05], [0, 0, 0]),
        k(1.3, [0, -0.1, 0.01], [deg(-30), 0, 0], 'out'),
        k(SEAT, rest.p, rest.r, 'snap'),
      ]},
      { node: 'handle', keys: [
        k(0.0, [0, 0.048, 0.085]),
        k(1.82, [0, 0.048, 0.085]),
        k(1.95, [0, 0.048, 0.17], undefined, 'snap'),
        k(2.05, [0, 0.048, 0.085], undefined, 'snap'),
      ]},
    ],
    events: [
      { t: 0.32, fn: () => ctx.sfx('out') },
      { t: 0.73, fn: () => { ctx.hideMag(); ctx.dropMag(); } },
      { t: 0.92, fn: () => { ctx.sfx('grab'); ctx.showMagHand(); } },
      { t: SEAT, fn: () => { ctx.sfx('in'); ctx.showMag(); ctx.hideMagHand(); } },
      { t: 1.62, fn: () => ctx.sfx('slap') },
      { t: 1.95, fn: () => ctx.sfx('rack') },
      { t: 2.05, fn: () => ctx.sfx('snap') },
    ],
  };
}

function sniper(ctx: Ctx): TimelineDef {
  const rest = MAG_REST.sniper;
  const SEAT = 1.45;
  return {
    duration: 2.95,
    tracks: [
      { node: 'gun', keys: [
        k(0.0, [0, 0, 0], [0, 0, 0]),
        k(0.3, [0.01, 0.02, 0.02], [deg(8), deg(5), deg(14)], 'out'),
        k(2.5, [0.01, 0.02, 0.02], [deg(8), deg(5), deg(14)], 'smooth'),
        k(2.9, [0, 0, 0], [0, 0, 0], 'inout'),
      ]},
      { node: 'lhand', keys: [
        k(0.0, [0, -0.095, -0.15], [deg(-70), 0, 0]),
        k(0.36, [0, -0.13, -0.02], [deg(-65), 0, 0], 'out'),
        k(0.68, [0, -0.25, 0.0], [deg(-65), 0, 0], 'smooth'),
        k(0.85, [-0.02, -0.33, 0.03], [deg(-70), 0, 0], 'in'),
        k(1.15, [0, -0.22, -0.01], [deg(-65), 0, 0], 'out'),
        k(1.5, [0, -0.12, -0.02], [deg(-65), 0, 0], 'snap'),
        k(1.78, [0, -0.095, -0.15], [deg(-70), 0, 0], 'inout'),
      ]},
      { node: 'mag', keys: [
        k(0.0, rest.p, rest.r),
        k(0.4, [0, -0.055, -0.02], [0, 0, 0], 'smooth'),
        k(0.7, [0, -0.3, 0.0], [deg(-10), 0, 0], 'in'),
        k(SEAT - 0.02, [0, -0.3, 0.0], [deg(-10), 0, 0], 'linear'),
        k(SEAT - 0.01, rest.p, rest.r, 'linear'),
      ]},
      { node: 'maghand', keys: [
        k(1.0, [0, -0.33, -0.01], [0, 0, 0]),
        k(1.32, [0, -0.12, -0.02], [0, 0, 0], 'out'),
        k(SEAT, rest.p, rest.r, 'snap'),
      ]},
      { node: 'rhand', keys: [
        k(0.0, [0, -0.085, 0.068], [deg(-14), 0, 0]),
        k(1.6, [0, -0.085, 0.068], [deg(-14), 0, 0], 'smooth'),
        k(1.8, [0.05, 0.02, 0.062], [deg(-20), 0, deg(-30)], 'out'),
        k(2.35, [0.05, 0.03, 0.13], [deg(-30), 0, deg(-30)], 'smooth'),
        k(2.6, [0.05, 0.02, 0.062], [deg(-20), 0, deg(-30)], 'smooth'),
        k(2.82, [0, -0.085, 0.068], [deg(-14), 0, 0], 'inout'),
      ]},
      { node: 'bolt', keys: [
        k(0.0, [0, 0.02, 0.045], [0, 0, 0]),
        k(1.85, [0, 0.02, 0.045], [0, 0, 0]),
        k(2.0, [0, 0.02, 0.045], [0, 0, deg(62)], 'snap'),
        k(2.22, [0, 0.02, 0.135], [0, 0, deg(62)], 'out'),
        k(2.45, [0, 0.02, 0.045], [0, 0, deg(62)], 'inout'),
        k(2.62, [0, 0.02, 0.045], [0, 0, 0], 'snap'),
      ]},
    ],
    events: [
      { t: 0.36, fn: () => ctx.sfx('out') },
      { t: 0.72, fn: () => { ctx.hideMag(); ctx.dropMag(); } },
      { t: 1.0, fn: () => { ctx.sfx('grab'); ctx.showMagHand(); } },
      { t: SEAT, fn: () => { ctx.sfx('in'); ctx.showMag(); ctx.hideMagHand(); } },
      { t: 1.55, fn: () => ctx.sfx('slap') },
      { t: 2.0, fn: () => ctx.sfx('snap') },
      { t: 2.22, fn: () => { ctx.sfx('rack'); ctx.ejectShell(); } },
      { t: 2.45, fn: () => ctx.sfx('snap') },
      { t: 2.62, fn: () => ctx.sfx('rack') },
    ],
  };
}

function sniperBolt(ctx: Ctx): TimelineDef {
  return {
    duration: 1.15,
    tracks: [
      { node: 'rhand', keys: [
        k(0.0, [0, -0.085, 0.068], [deg(-14), 0, 0]),
        k(0.14, [0.05, 0.02, 0.062], [deg(-20), 0, deg(-30)], 'out'),
        k(0.8, [0.05, 0.025, 0.062], [deg(-20), 0, deg(-30)], 'smooth'),
        k(1.0, [0, -0.085, 0.068], [deg(-14), 0, 0], 'inout'),
      ]},
      { node: 'bolt', keys: [
        k(0.0, [0, 0.02, 0.045], [0, 0, 0]),
        k(0.18, [0, 0.02, 0.045], [0, 0, deg(62)], 'snap'),
        k(0.36, [0, 0.02, 0.135], [0, 0, deg(62)], 'out'),
        k(0.62, [0, 0.02, 0.045], [0, 0, deg(62)], 'inout'),
        k(0.8, [0, 0.02, 0.045], [0, 0, 0], 'snap'),
      ]},
      { node: 'gun', keys: [
        k(0.0, [0, 0, 0], [0, 0, 0]),
        k(0.2, [0, 0.004, 0.01], [deg(2), 0, deg(3)], 'out'),
        k(0.7, [0, 0.004, 0.01], [deg(2), 0, deg(3)], 'smooth'),
        k(1.1, [0, 0, 0], [0, 0, 0], 'inout'),
      ]},
    ],
    events: [
      { t: 0.16, fn: () => ctx.sfx('snap') },
      { t: 0.36, fn: () => { ctx.sfx('rack'); ctx.ejectShell(); } },
      { t: 0.62, fn: () => ctx.sfx('snap') },
      { t: 0.8, fn: () => ctx.sfx('rack') },
    ],
  };
}

function bazooka(ctx: Ctx): TimelineDef {
  const SEAT_Z = -0.3;
  const SWAP = 1.78;
  return {
    duration: 2.75,
    tracks: [
      { node: 'gun', keys: [
        k(0.0, [0, 0, 0], [0, 0, 0]),
        k(0.3, [0.04, -0.02, 0.03], [deg(14), deg(-20), deg(16)], 'out'),
        k(2.2, [0.04, -0.02, 0.03], [deg(14), deg(-20), deg(16)], 'smooth'),
        k(2.7, [0, 0, 0], [0, 0, 0], 'inout'),
      ]},
      { node: 'lhand', keys: [
        k(0.0, [0, -0.11, -0.19], [deg(-90), 0, 0]),
        k(0.28, [0.08, -0.26, -0.1], [deg(-70), 0, 0], 'out'),
        k(0.5, [0.22, -0.36, -0.1], [deg(-52), 0, deg(-18)], 'smooth'),
        k(0.92, [0.18, -0.24, -0.34], [deg(-34), 0, deg(-12)], 'out'),
        k(1.28, [0.06, -0.1, -0.5], [deg(-18), 0, deg(-4)], 'smooth'),
        k(1.45, [0, -0.095, -0.54], [deg(-16), 0, 0], 'smooth'),
        k(1.7, [0, -0.095, -0.36], [deg(-16), 0, 0], 'in'),
        k(SWAP, [0, -0.1, -0.33], [deg(-18), 0, 0], 'snap'),
        k(2.0, [0, -0.105, -0.3], [deg(-40), 0, 0], 'out'),
        k(2.35, [0, -0.11, -0.22], [deg(-70), 0, 0], 'smooth'),
        k(2.6, [0, -0.11, -0.19], [deg(-90), 0, 0], 'inout'),
      ]},
      { node: 'warheadhand', keys: [
        k(0.5, [0.22, -0.34, -0.16], [deg(12), deg(-58), 0]),
        k(0.92, [0.17, -0.2, -0.42], [deg(6), deg(-32), 0], 'out'),
        k(1.28, [0.06, -0.06, -0.58], [deg(2), deg(-10), 0], 'smooth'),
        k(1.45, [0, 0, -0.62], [0, 0, 0], 'smooth'),
        k(1.7, [0, 0, -0.28], [0, 0, 0], 'in'),
        k(SWAP, [0, 0, SEAT_Z], [0, 0, 0], 'snap'),
      ]},
    ],
    events: [
      { t: 0.5, fn: () => { ctx.sfx('grab'); ctx.showWarheadHand(); } },
      { t: 1.45, fn: () => ctx.sfx('snap') },
      { t: 1.7, fn: () => ctx.sfx('in') },
      { t: SWAP, fn: () => { ctx.sfx('twist'); ctx.showWarhead(); ctx.hideWarheadHand(); } },
      { t: 1.95, fn: () => ctx.sfx('slap') },
    ],
  };
}

function inspect(ctx: Ctx): TimelineDef {
  return {
    duration: 1.8,
    tracks: [
      { node: 'gun', keys: [
        k(0.0, [0, 0, 0], [0, 0, 0]),
        k(0.35, [-0.06, 0.02, 0.04], [deg(6), deg(-42), deg(18)], 'out'),
        k(0.9, [-0.05, 0.03, 0.04], [deg(10), deg(-38), deg(24)], 'smooth'),
        k(1.2, [-0.04, 0.015, 0.03], [deg(4), deg(-46), deg(15)], 'inout'),
        k(1.75, [0, 0, 0], [0, 0, 0], 'inout'),
      ]},
    ],
    events: [
      { t: 0.28, fn: () => ctx.sfx('grab') },
      { t: 1.2, fn: () => ctx.sfx('snap') },
    ],
  };
}

export function buildTimeline(key: string, ctx: Ctx): TimelineDef {
  switch (key) {
    case 'reload_handgun': return handgun(ctx);
    case 'reload_smg': return smg(ctx);
    case 'reload_rifle': return rifle(ctx);
    case 'reload_sniper': return sniper(ctx);
    case 'reload_bazooka': return bazooka(ctx);
    case 'bolt_sniper': return sniperBolt(ctx);
    default: return inspect(ctx);
  }
}
