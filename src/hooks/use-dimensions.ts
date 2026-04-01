import { useState, useEffect } from 'react';

export interface Dimensions {
  cols: number;
  rows: number;
}

export function useDimensions(stdout: NodeJS.WriteStream = process.stdout): Dimensions {
  const [dims, setDims] = useState<Dimensions>({
    cols: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  useEffect(() => {
    const handler = () => {
      setDims({
        cols: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    };
    stdout.on('resize', handler);
    return () => { stdout.off('resize', handler); };
  }, [stdout]);

  return dims;
}
