export interface StartupRequestBudget {
  tryConsume: (taskName: string) => boolean;
  remaining: () => number;
}

export function createStartupRequestBudget(limit: number): StartupRequestBudget {
  const consumed = new Set<string>();
  return {
    tryConsume(taskName: string): boolean {
      if (consumed.has(taskName)) return true;
      if (consumed.size >= limit) return false;
      consumed.add(taskName);
      return true;
    },
    remaining(): number {
      return Math.max(0, limit - consumed.size);
    },
  };
}
