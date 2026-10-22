/**
 * Limitador en memoria por clave (IP). En Lambda el estado es por instancia, por lo que
 * es una defensa en profundidad: la protección principal es una clave larga y aleatoria.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxHits: number, private readonly windowMs: number) {}

  /** Segundos de espera si la clave está bloqueada; 0 si puede continuar. */
  retryAfterSeconds(key: string): number {
    const entry = this.hits.get(key);
    if (!entry || Date.now() > entry.resetAt) return 0;
    return entry.count >= this.maxHits ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
  }

  record(key: string): void {
    const now = Date.now();
    if (this.hits.size > 10_000) this.prune(now);
    const entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now > entry.resetAt) this.hits.delete(key);
    }
  }
}
