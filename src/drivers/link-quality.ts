/**
 * How healthy the network link to the telescope is, from its keepalives: the Dwarf's text ping/pong
 * on the control socket (answered by the socket itself, so pure network time) and the Seestar's
 * test_connection heartbeat (through the ZWO tunnel when it is remote).
 *
 * Latency alone hides what actually breaks a session: replies that never come (a Wi-Fi dropout, a
 * stalled relay). So the grade weighs the share of keepalives that went unanswered as well as the
 * median round trip, over the last WINDOW of them; jitter (how far the slow ones run past the
 * median) is reported alongside.
 *
 * The grade is against what is normal for the path: on Wi-Fi or the LAN a round trip is a few to a
 * few tens of ms, while through ZWO Telescope Network's relay a few hundred ms is a healthy link. One
 * scale for both would call every remote night "poor" and miss a LAN that has gone sluggish.
 */

export type LinkGrade = 'good' | 'fair' | 'poor' | 'bad';
/** lan: Wi-Fi or wired, straight to the scope; remote: through a relay (ZWO Telescope Network) */
export type LinkPath = 'lan' | 'remote';

export interface LinkQuality {
  /** the path the grade is judged for */
  path: LinkPath;
  /** null until enough keepalives were seen to judge */
  grade: LinkGrade | null;
  /** median round trip of the answered keepalives, ms */
  rttMs: number | null;
  /** the 90th percentile less the median, ms: how uneven the link is */
  jitterMs: number | null;
  /** unanswered keepalives in the window, percent */
  lossPct: number;
  /** keepalives in the window (answered + unanswered) */
  samples: number;
  /** the newest answered round trip, ms */
  lastRttMs: number | null;
}

const WINDOW = 30;
const MIN_SAMPLES = 3;

/** Thresholds per path and grade: the median round trip and the loss it may not exceed (worse is 'bad'). */
const GRADES: Record<LinkPath, Array<{ grade: LinkGrade; rttMs: number; lossPct: number }>> = {
  lan: [
    { grade: 'good', rttMs: 100, lossPct: 5 },
    { grade: 'fair', rttMs: 300, lossPct: 15 },
    { grade: 'poor', rttMs: 1000, lossPct: 40 },
  ],
  remote: [
    { grade: 'good', rttMs: 500, lossPct: 5 },
    { grade: 'fair', rttMs: 1200, lossPct: 15 },
    { grade: 'poor', rttMs: 3000, lossPct: 40 },
  ],
};

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

export class LinkQualityTracker {
  /** round trip in ms, or null for a keepalive that went unanswered */
  private readonly window: Array<number | null> = [];
  private last: number | null = null;

  constructor(readonly path: LinkPath = 'lan') {}

  answered(rttMs: number): void {
    this.push(Math.max(0, Math.round(rttMs)));
    this.last = Math.max(0, Math.round(rttMs));
  }

  missed(): void {
    this.push(null);
  }

  /** A new connection: the old one's numbers say nothing about it. */
  reset(): void {
    this.window.length = 0;
    this.last = null;
  }

  private push(v: number | null): void {
    this.window.push(v);
    if (this.window.length > WINDOW) this.window.shift();
  }

  snapshot(): LinkQuality {
    const rtts = this.window.filter((v): v is number => v !== null).sort((a, b) => a - b);
    const samples = this.window.length;
    const lossPct = samples ? Math.round(((samples - rtts.length) / samples) * 100) : 0;
    const rttMs = rtts.length ? pct(rtts, 0.5) : null;
    const jitterMs = rtts.length >= MIN_SAMPLES ? pct(rtts, 0.9) - rttMs! : null;
    let grade: LinkGrade | null = null;
    if (samples >= MIN_SAMPLES) {
      grade = 'bad';
      for (const g of GRADES[this.path]) {
        if ((rttMs === null ? Infinity : rttMs) <= g.rttMs && lossPct <= g.lossPct) {
          grade = g.grade;
          break;
        }
      }
    }
    return { path: this.path, grade, rttMs, jitterMs, lossPct, samples, lastRttMs: this.last };
  }

  /** What the UI shows changed (the grade, the median to two figures, the loss): worth publishing. */
  static differs(a: LinkQuality | null, b: LinkQuality): boolean {
    if (!a) return true;
    const fig = (v: number | null) => (v === null ? null : Number(v.toPrecision(2)));
    return a.grade !== b.grade || fig(a.rttMs) !== fig(b.rttMs) || a.lossPct !== b.lossPct;
  }
}
