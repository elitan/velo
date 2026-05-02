import { z } from 'zod';
import { publicProcedure } from './context';
import { userFacingError } from './errors';
import {
  deleteTableRow,
  getTableBrowserMetadata,
  getTableRows,
  insertTableRow,
  updateTableRow,
} from '#server/services/table-browser-service';

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

const tableRowValues = z.record(z.string(), z.string().nullable());

const tableInsertInput = z.object({
  branchId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().min(1),
  table: z.string().min(1),
  values: tableRowValues,
});

const tableUpdateInput = tableInsertInput.extend({
  rowId: z.string().min(1),
});

const tableDeleteInput = tableRowsInput.extend({
  rowId: z.string().min(1),
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
  insert: publicProcedure
    .input(tableInsertInput)
    .handler(async function insertRow({ input }) {
      try {
        return await insertTableRow(input);
      } catch (error) {
        throw userFacingError(error, 'Could not insert row');
      }
    }),
  update: publicProcedure
    .input(tableUpdateInput)
    .handler(async function updateRow({ input }) {
      try {
        return await updateTableRow(input);
      } catch (error) {
        throw userFacingError(error, 'Could not update row');
      }
    }),
  delete: publicProcedure
    .input(tableDeleteInput)
    .handler(async function deleteRow({ input }) {
      try {
        return await deleteTableRow(input);
      } catch (error) {
        throw userFacingError(error, 'Could not delete row');
      }
    }),
};
