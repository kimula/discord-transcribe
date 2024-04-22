import fs from 'fs';

export const arrayEqual = <A>(as: A[], bs: A[]): boolean =>
  as.length === bs.length && as.every((a, i) => a === bs[i]);

export const round = (n: number, precision: number): number => {
  const factor = Math.pow(10, precision);
  return Math.round(n * factor) / factor;
}

export const rmIfExistsSync = (path: fs.PathLike, options?: fs.RmOptions): void => {
  if (fs.existsSync(path))
    fs.rmSync(path, options);
}
