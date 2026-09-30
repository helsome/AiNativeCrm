import type { Pool } from "pg";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

/** Fail closed before CRM writes when a long-running worker has lost its queue lease. */
export async function assertWorkbenchJobLease(
  pool: Pool,
  job: JobRow,
  workerId: string,
): Promise<void> {
  const claim = claimOfJob(job);
  if (!claim || claim.worker_id !== workerId) throw new Error("workbench_job_lease_missing");
  const { rows } = await pool.query<{ current: boolean }>(
    `select exists (
       select 1 from job_queue
       where id=$1 and organization_id=$2 and status='running'
         and locked_by=$3 and locked_at=$4::timestamptz
     ) as current`,
    [job.id, job.organization_id, workerId, claim.acquired_at],
  );
  if (!rows[0]?.current) throw new Error("workbench_job_lease_lost");
}
