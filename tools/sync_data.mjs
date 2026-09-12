/**
 * Копирует производные данные из data/ в public/data/, откуда их читает игра.
 *
 * Две копии одних и тех же файлов неизбежно разъезжаются: пайплайн пишет
 * в data/, а fetch в рантайме ходит в public/. Скрипт повешен на predev
 * и prebuild, поэтому забыть синхронизацию нельзя.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'data');
const to = join(root, 'public', 'data');

mkdirSync(to, { recursive: true });

const needed = readdirSync(from).filter((f) => f.endsWith('.geojson') || f.endsWith('.json'));
for (const f of needed) copyFileSync(join(from, f), join(to, f));

console.log(`data → public/data: ${needed.join(', ')}`);
