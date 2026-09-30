export interface CreditUsageInput {
  totalCredits: number;
  usedCredits: number;
  remainingCredits: number;
  paid: boolean;
}

export interface CreditUsage {
  totalCredits: number;
  usedCredits: number;
  remainingCredits: number;
  percentage: number;
  paid: boolean;
}

export function getCreditUsage(input: CreditUsageInput): CreditUsage {
  const totalCredits = Math.max(0, input.totalCredits);
  const usedCredits = Math.max(0, input.usedCredits);
  const remainingCredits = Math.max(0, input.remainingCredits);
  const percentage = totalCredits === 0
    ? 0
    : Math.min(100, Math.max(0, (usedCredits / totalCredits) * 100));

  return {
    totalCredits,
    usedCredits,
    remainingCredits,
    percentage,
    paid: input.paid,
  };
}
