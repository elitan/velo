import * as path from 'path';
import * as os from 'os';
import { APP_SLUG } from '../config/constants';

const homeDir = os.homedir();
const dataDir = path.join(homeDir, `.${APP_SLUG}`);

export const PATHS = {
  WAL_ARCHIVE: path.join(dataDir, 'wal-archive'),
  DATA_DIR: dataDir,
};
