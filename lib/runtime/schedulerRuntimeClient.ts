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

  const [realActive, simActive] = await Promise.all([
    fetchActive('/api/scheduler'),
    fetchActive('/api/sim-scheduler'),
  ]);

  return {
    realActive,
    simActive,
    fetchedAt: Date.now(),
  };
}
