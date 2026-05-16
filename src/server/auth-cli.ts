import { setPassword } from './auth';

const password = process.env.APP_PASSWORD || process.argv[2] || '';

if (!password) {
  throw new Error('Set APP_PASSWORD or pass password as the first argument.');
}

await setPassword(password);
console.log('app password set');
