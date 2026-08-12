export function caseProgressBucket(completed, total) {
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1 || completed < 1 || completed > total) {
    throw new TypeError("Case progress coordinates are invalid.");
  }
  return Math.min(100, Math.ceil(completed * 100 / total));
}

export function caseProgressDecision(completed, total, lastBucket) {
  if (!Number.isSafeInteger(lastBucket) || lastBucket < -1 || lastBucket > 100) {
    throw new TypeError("Last case progress bucket is invalid.");
  }
  const bucket = caseProgressBucket(completed, total);
  return {
    bucket,
    emit: completed === 1 || completed === total || (bucket < 100 && bucket !== lastBucket),
  };
}
