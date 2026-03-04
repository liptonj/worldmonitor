export type StartupTaskName = string;

export interface StartupLoadProfile {
  initialRequestBudget: number;
  phaseA: StartupTaskName[];
  phaseB: StartupTaskName[];
  phaseC: StartupTaskName[];
}

export function getStartupLoadProfile(variant: string): StartupLoadProfile {
  // Minimal full-profile default; variant refinements come later.
  return {
    initialRequestBudget: 10,
    phaseA: ['news', 'markets'],
    phaseB: ['predictions', 'fred', 'oil', 'bis', 'pizzint'],
    phaseC: ['intelligence', 'natural', 'weather', 'ais', 'cables', 'cyberThreats'],
  };
}
