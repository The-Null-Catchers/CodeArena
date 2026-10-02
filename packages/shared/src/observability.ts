export interface LogFields {
  event: string;
  correlationId?: string;
  submissionId?: string;
  projectId?: string;
  workerId?: string;
  [key: string]: unknown;
}

export function structuredLog(
  service: string,
  fields: LogFields,
  level: "info" | "error" = "info",
) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    service,
    event: fields.event,
    correlation_id:
      fields.correlationId ??
      fields.submissionId ??
      fields.projectId ??
      fields.workerId ??
      null,
    ...fields,
  });
  if (level === "error") console.error(payload);
  else console.log(payload);
}
