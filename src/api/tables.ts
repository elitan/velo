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
  offset: z.coerce.number().int().min(0).optional(),
});

const tableRowValues = z.record(z.string(), z.string().nullable());

const tableInsertInput = z.object({
  branchId: z.string().min(1),
  database: z.string().min(1),
  schema: z.string().min(1),
  table: z.string().min(1),
  values: tableRowValues,
  productionWriteConfirmation: z.string().optional(),
});

const tableUpdateInput = tableInsertInput.extend({
  rowId: z.string().min(1),
});

const tableDeleteInput = tableRowsInput.extend({
  rowId: z.string().min(1),
  productionWriteConfirmation: z.string().optional(),
});

export const tablesRouter = {
  browse: publicProcedure
    .route({ method: 'GET', path: '/branches/{branchId}/tables', summary: 'Browse branch tables' })
    .input(tableBrowserInput)
    .handler(async function browseTables({ input }) {
      return getTableBrowserMetadata(input);
    }),
  rows: publicProcedure
    .route({ method: 'GET', path: '/branches/{branchId}/tables/{database}/{schema}/{table}/rows', summary: 'List table rows' })
    .input(tableRowsInput)
    .handler(async function browseRows({ input }) {
      return getTableRows(input);
    }),
  insert: publicProcedure
    .route({ method: 'POST', path: '/branches/{branchId}/tables/{database}/{schema}/{table}/rows', successStatus: 201, summary: 'Insert table row' })
    .input(tableInsertInput)
    .handler(async function insertRow({ input }) {
      try {
        return await insertTableRow(input);
      } catch (error) {
        throw userFacingError(error, 'Could not insert row');
      }
    }),
  update: publicProcedure
    .route({ method: 'PATCH', path: '/branches/{branchId}/tables/{database}/{schema}/{table}/rows/{rowId}', summary: 'Update table row' })
    .input(tableUpdateInput)
    .handler(async function updateRow({ input }) {
      try {
        return await updateTableRow(input);
      } catch (error) {
        throw userFacingError(error, 'Could not update row');
      }
    }),
  delete: publicProcedure
    .route({ method: 'DELETE', path: '/branches/{branchId}/tables/{database}/{schema}/{table}/rows/{rowId}', summary: 'Delete table row' })
    .input(tableDeleteInput)
    .handler(async function deleteRow({ input }) {
      try {
        return await deleteTableRow(input);
      } catch (error) {
        throw userFacingError(error, 'Could not delete row');
      }
    }),
};
