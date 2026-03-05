export type StartupTaskName = string;

export interface StartupLoadProfile {
  initialRequestBudget: number;
  phaseBDelayMs: number;
  phaseA: StartupTaskName[];
  phaseB: StartupTaskName[];
  phaseC: StartupTaskName[];
}

export function getStartupLoadProfile(_variant: string): StartupLoadProfile {
  // Minimal full-profile default; variant refinements come later.
  return {
    initialRequestBudget: 10,
    phaseBDelayMs: 2000, // 2 seconds after Phase A awaited — gives browser time to render
    phaseA: ['news', 'markets'],
    phaseB: ['predictions', 'fred', 'oil', 'bis', 'pizzint'],
    phaseC: ['intelligence', 'natural', 'weather', 'ais', 'cables', 'cyberThreats'],
  };
}
