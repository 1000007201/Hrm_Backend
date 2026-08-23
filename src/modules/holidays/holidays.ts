import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { toUtcDateKey } from "../../shared/workingDays.js";

type Db = PrismaClient | Prisma.TransactionClient;

// Builds the holiday-key set countWorkingDays expects, for one org over one
// date range. This is the only intended way to build that set — it pairs the
// tenant-scoped query with toUtcDateKey so the key format can't drift from
// what countWorkingDays looks up.
export const getHolidayDateKeys = async (
  db: Db,
  organizationId: string,
  startDate: Date,
  endDate: Date,
): Promise<Set<string>> => {
  const holidays = await db.holiday.findMany({
    where: { organizationId, date: { gte: startDate, lte: endDate } },
    select: { date: true },
  });

  return new Set(holidays.map((holiday) => toUtcDateKey(holiday.date)));
};

// A holiday's `year` column is derived from its date rather than accepted
// from the client — see the comment on Holiday.year in prisma/schema.prisma.
export const toHolidayYear = (date: Date): number => date.getUTCFullYear();
