export interface SchedulerRuntimeActiveSnapshot {
  realActive: boolean;
  simActive: boolean;
  fetchedAt: number;
}

export async function fetchSchedulerRuntimeActiveSnapshot(): Promise<SchedulerRuntimeActiveSnapshot> {
  const fetchActive = async (url: string): Promise<boolean> => {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return false;
      const payload = await response.json() as { active?: boolean };
      return !!payload.active;
    } catch {
      return false;
    }
  };

  const simActive = await fetchActive('/api/sim-scheduler');

  return {
    realActive: false,
    simActive,
    fetchedAt: Date.now(),
  };
}
