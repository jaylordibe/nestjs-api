import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

const result = dotenv.config({
  path: resolve(__dirname, '../../.env.test'),
});
expand(result);
