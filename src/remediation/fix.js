export function computeDiffSegments(original, fixed) {
  const origLines = original.split('\n');
  const fixedLines = fixed.split('\n');
  const segments = [];
  const context = 3;
  let i = 0;
  let j = 0;

  while (i < origLines.length || j < fixedLines.length) {
    if (i < origLines.length && j < fixedLines.length && origLines[i] === fixedLines[j]) {
      i++;
      j++;
      continue;
    }

    const startI = i;
    const startJ = j;
    let synced = false;

    for (let look = 1; look <= 30 && !synced; look++) {
      for (let ki = 0; ki <= look; ki++) {
        const kj = look - ki;
        if ((i + ki) < origLines.length && (j + kj) < fixedLines.length && origLines[i + ki] === fixedLines[j + kj]) {
          segments.push({
            lineNum: startI + 1,
            beforeLines: origLines.slice(Math.max(0, startI - context), i + ki).join('\n'),
            afterLines: fixedLines.slice(Math.max(0, startJ - context), j + kj).join('\n'),
          });
          i += ki;
          j += kj;
          synced = true;
          break;
        }
      }
    }

    if (!synced) {
      segments.push({
        lineNum: startI + 1,
        beforeLines: origLines.slice(startI).join('\n'),
        afterLines: fixedLines.slice(startJ).join('\n'),
      });
      break;
    }

    if (segments.length >= 10) break;
  }

  return segments;
}
