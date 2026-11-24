import logger from '@/server/logger';
import db from '@/server/db';
import { InitiatedBy, TimeRange } from '@/features/settings/types/analytics';
import { Prisma } from '@prisma/client';

type ModelCosts = {
  id: string;
  label: string;
  cost: number;
};

type ProviderCosts = {
  id: string;
  label: string;
  costPerInputToken: number;
  costPerOutputToken: number;
  cost: number;
  models: ModelCosts[];
};

type UsageRecords = {
  initiatedBy: InitiatedBy;
  aiProvider?: string;
  model?: string;
  timeRange: TimeRange;
  totalCost: number;
  providers: ProviderCosts[];
};

export default async function getUsageRecords(
  initiatedBy: InitiatedBy,
  aiProvider: string,
  model: string,
  timeRange: TimeRange
): Promise<UsageRecords> {
  let aiProviderLabel: string | undefined;
  let modelLabel: string | undefined;

  // Use a map to keep the SQL query abstracted from the TimeRange enum string values
  // Also helps with SQL injection prevention by sanitizing the interval parameter
  const timeRangeMap = {
    // [enum] : 'SQL interval value'
    [TimeRange.Day]: '24 hours',
    [TimeRange.Week]: '7 days',
    [TimeRange.Month]: '30 days',
    [TimeRange.Year]: '365 days',
  };
  const interval = timeRangeMap[timeRange];

  let whereClause = Prisma.sql`
    WHERE
      -- One range predicate keeps row estimates sane when Postgres reuses a generic plan;
      -- the sub-select computes the cutoff once instead of once per row
      "apu"."timestamp" >= (SELECT NOW() - CAST(${interval} AS INTERVAL))
  `;

  if (initiatedBy === InitiatedBy.User) {
    // Only show usage records initiated by user(s)
    whereClause = Prisma.sql`${whereClause} AND "apu"."system" = FALSE`;
  } else if (initiatedBy === InitiatedBy.System) {
    // Only show usage records initiated by the system
    whereClause = Prisma.sql`${whereClause} AND "apu"."system" = TRUE`;
  }

  if (aiProvider !== 'all') {
    // Get the AI provider label based on the ID
    // Also helps with SQL injection prevention by verifying the ID is valid
    const aiProviderRecord = await db.aiProvider.findUnique({
      where: {
        id: aiProvider,
        deletedAt: null,
      },
    });

    if (!aiProviderRecord) {
      logger.error('AI provider not found');
      throw new Error('AI provider not found');
    }

    aiProviderLabel = aiProviderRecord.label;

    // Cast the AI provider ID to a UUID for comparison
    const aiProviderUUID = Prisma.sql`CAST(${aiProvider} AS UUID)`;
    whereClause = Prisma.sql`${whereClause} AND "apu"."aiProviderId" = ${aiProviderUUID}`;
  }

  if (model !== 'all') {
    // Get the model label based on the ID
    // Also helps with SQL injection prevention by verifying the ID is valid
    const modelRecord = await db.model.findUnique({
      where: {
        id: model,
        deletedAt: null,
      },
    });

    if (!modelRecord) {
      logger.error('Model not found');
      throw new Error('Model not found');
    }

    modelLabel = modelRecord.name;

    // Cast the model ID to a UUID for comparison
    const modelUUID = Prisma.sql`CAST(${model} AS UUID)`;
    whereClause = Prisma.sql`${whereClause} AND "apu"."modelId" = ${modelUUID}`;
  }

  let totalCost: number | null = null;
  try {
    // Aggregate the usage rows once, by provider, model and token rates, then roll the
    // model, provider and overall totals up from those few rows. Reading the raw rows
    // through a shared CTE materializes every matching row and scans it three times.
    // Token counts are summed exactly, so the totals do not depend on row order.
    const rawRecords = await db.$queryRaw<any[]>`
      WITH rate_aggregates AS (
        SELECT
            "apu"."aiProviderId",
            "apu"."modelId",
            "apu"."costPerInputToken",
            "apu"."costPerOutputToken",
            SUM("apu"."inputTokensUsed") AS "inputTokensUsed",
            SUM("apu"."outputTokensUsed") AS "outputTokensUsed",
            COUNT(*) AS "usageCount"
        FROM
            "AiProviderUsage" apu

        -- Apply filters for AI provider, model and time period
        ${whereClause}
        GROUP BY
            "apu"."aiProviderId", "apu"."modelId", "apu"."costPerInputToken", "apu"."costPerOutputToken"
      ),

      model_aggregates AS (
        SELECT
            "ra"."aiProviderId",
            "ap"."label" AS "aiProviderLabel",
            "ra"."modelId",
            "m"."name" AS "modelLabel",
            SUM(
              "ra"."inputTokensUsed"::numeric * "ra"."costPerInputToken"::numeric
              + "ra"."outputTokensUsed"::numeric * "ra"."costPerOutputToken"::numeric
            ) AS "totalCost",
            SUM("ra"."costPerInputToken"::numeric * "ra"."usageCount") AS "sumCostPerInputToken",
            SUM("ra"."costPerOutputToken"::numeric * "ra"."usageCount") AS "sumCostPerOutputToken",
            SUM("ra"."usageCount") AS "usageCount"
        FROM
            rate_aggregates ra
        LEFT JOIN
            "AiProvider" ap ON "ra"."aiProviderId" = "ap"."id"
        LEFT JOIN
            "Model" m ON "ra"."modelId" = "m"."id"
        WHERE
            "ap"."deletedAt" IS NULL
            AND "m"."deletedAt" IS NULL
        GROUP BY
            "ra"."aiProviderId", "ap"."label", "ra"."modelId", "m"."name"
      ),

      provider_aggregates AS (
        SELECT
            "aiProviderId",
            "aiProviderLabel",
            (SUM("sumCostPerInputToken") / SUM("usageCount"))::float8 AS "costPerInputToken",
            (SUM("sumCostPerOutputToken") / SUM("usageCount"))::float8 AS "costPerOutputToken",
            SUM("totalCost")::float8 AS "totalCost"
        FROM
            model_aggregates
        GROUP BY
            "aiProviderId", "aiProviderLabel"
      ),

      -- Only calculate the total cost once
      total_cost AS (
        SELECT SUM("totalCost")::float8 AS "totalCost"
        FROM model_aggregates
      )

      SELECT
        "pa"."aiProviderId",
        "pa"."aiProviderLabel",
        "pa"."costPerInputToken",
        "pa"."costPerOutputToken",
        "pa"."totalCost" AS "providerTotalCost",
        "ma"."modelId",
        "ma"."modelLabel",
        "ma"."totalCost"::float8 AS "modelTotalCost",
        "tc"."totalCost" AS "overallTotalCost"
      FROM
        provider_aggregates pa
      LEFT JOIN
        model_aggregates ma ON "pa"."aiProviderId" = "ma"."aiProviderId",
        total_cost tc;
    `;

    if (rawRecords === null) {
      logger.error('Unexpected null result from database query.');
      throw new Error('Unexpected null result from database query.');
    }

    if (rawRecords.length === 0) {
      logger.info('No usage records found');
    }

    // Extract totalCost from the first record (since it's the same for all records)
    // If there are no records, set totalCost to 0
    totalCost = rawRecords.length !== 0 ? rawRecords[0].overallTotalCost : 0;

    if (totalCost === null) {
      logger.error('Unexpected null result from database query.');
      throw new Error('Total cost was unexpectedly null.');
    }

    // Transform raw records into the desired structure
    const providersMap: { [key: string]: ProviderCosts } = {};

    rawRecords.forEach((record) => {
      if (!providersMap[record.aiProviderId]) {
        providersMap[record.aiProviderId] = {
          id: record.aiProviderId,
          label: record.aiProviderLabel,
          costPerInputToken: record.costPerInputToken,
          costPerOutputToken: record.costPerOutputToken,
          cost: record.providerTotalCost,
          models: [],
        };
      }
      if (record.modelId) {
        providersMap[record.aiProviderId].models.push({
          id: record.modelId,
          label: record.modelLabel,
          cost: record.modelTotalCost,
        });
      }
    });

    // Get all providers in case some have no usage records
    const allProviders = await db.aiProvider.findMany({
      where:
        aiProvider === 'all'
          ? {
              deletedAt: null,
            }
          : {
              id: aiProvider,
              deletedAt: null,
            },
      select: {
        id: true,
        label: true,
        costPerInputToken: true,
        costPerOutputToken: true,
        models: {
          select: {
            id: true,
            name: true,
          },
          where:
            model === 'all'
              ? {
                  deletedAt: null,
                }
              : {
                  id: model,
                  deletedAt: null,
                },
        },
      },
    });

    // Add providers with no usage records to providersMap
    allProviders.forEach((provider) => {
      if (!providersMap[provider.id]) {
        providersMap[provider.id] = {
          id: provider.id,
          label: provider.label,
          costPerInputToken: provider.costPerInputToken,
          costPerOutputToken: provider.costPerOutputToken,
          cost: 0,
          models: provider.models.map((model) => ({
            id: model.id,
            label: model.name,
            cost: 0,
          })),
        };

      } else if (model === 'all') {
        provider.models.forEach(model => {
          if (!providersMap[provider.id].models.some(m => m.id === model.id)) {
            providersMap[provider.id].models.push({
              id: model.id,
              label: model.name,
              cost: 0,
            });
          }
        });
      }
    });

    const providers = Object.values(providersMap);

    return {
      initiatedBy: initiatedBy,
      aiProvider: aiProviderLabel,
      model: modelLabel,
      timeRange: timeRange,
      totalCost: totalCost,
      providers: providers,
    };
  } catch (error) {
    logger.error('Error fetching usage records', error);
    throw new Error('Error fetching usage records');
  }
}
