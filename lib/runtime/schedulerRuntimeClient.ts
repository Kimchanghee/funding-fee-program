export interface SchedulerRuntimeActiveSnapshot {
  realActive: boolean;
  simActive: boolean;
  fetchedAt: number;
}

export async function fetchSchedulerRuntimeActiveSnapshot(): Promise<SchedulerRuntimeActiveSnapshot> {
  const [realResponse, simResponse] = await Promise.all([
    fetch('/api/scheduler'),
    fetch('/api/sim-scheduler'),
  ]);

  if (!realResponse.ok || !simResponse.ok) {
    throw new Error(`HTTP real=${realResponse.status} sim=${simResponse.status}`);
  }

  const [realPayload, simPayload] = await Promise.all([
    realResponse.json() as Promise<{ active?: boolean }>,
    simResponse.json() as Promise<{ active?: boolean }>,
  ]);

  return {
    realActive: !!realPayload.active,
    simActive: !!simPayload.active,
    fetchedAt: Date.now(),
  };
}

