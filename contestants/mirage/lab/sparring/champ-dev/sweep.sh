#!/bin/zsh
# Robustness sweep: flags pathological rounds (zone damage, no shots, self hits, stalemates, slow ticks).
#   zsh lab/sparring/champ-dev/sweep.sh [rounds-per-run=16]
cd "$(dirname $0)/../../.."
n=${1:-16}
out=lab/sparring/champ-dev/out; mkdir -p $out
i=0
for opp in hunter dummy lab/sparring/champ-dev lab/sparring/champ-dev/v1 lab/sparring/champ-dev/v2; do
  for seed in 1 2; do
    i=$((i+1)); node lab/sparring/champ-dev/bench.mjs --vs $opp --rounds $n --jitter $seed > $out/$i.txt 2>&1 &
  done
done
wait
cat $out/*.txt | grep -E "^R" | awk '{
  flag="";
  if (match($0, /zone [0-9]+ \|/)) { z=substr($0, RSTART+5, RLENGTH-7)+0; if (z > 20) flag=flag" ZONE" z }
  if (match($0, /self [1-9][0-9]* kit/)) flag=flag" SELF";
  if ($0 ~ /A 0\/0 /) flag=flag" NOSHOTS";
  if ($0 ~ /120.0s time HP 100\/100 vs 1[0-9]*\/1/) { if ($0 ~ /vs 100\/100|vs 175\/175/) flag=flag" STALE" }
  if (flag != "") print flag " :: " $0
}'
echo '--- totals'
grep -h -E " vs .*[0-9]+W|acc|tick avg" $out/*.txt | grep -v "hit distances"
