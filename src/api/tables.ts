import { z } from 'zod';
import { publicProcedure } from './context';
import { getTableBrowserMetadata, getTableRows } from '#server/services/table-browser-service';

const tableBrowserInput = z.object({
  branchId: z.string().min(1),
  database: z.string().min(1).optional(),
  schema: z.string().min(1).optional(),
  table: z.string().min(1).optional(),
});

const tableRowsInput = z.object({
  branchId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().min(1),
  table: z.string().min(1),
  offset: z.number().int().min(0).optional(),
});

export const tablesRouter = {
  browse: publicProcedure
    .input(tableBrowserInput)
    .handler(async function browseTables({ input }) {
      return getTableBrowserMetadata(input);
    }),
  rows: publicProcedure
    .input(tableRowsInput)
    .handler(async function browseRows({ input }) {
      return getTableRows(input);
    }),
};
