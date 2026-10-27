#!/bin/bash
# Two-session proof for migration 018 (design-version-checked-save §8 "SQL", "Lock order").
# Usage: PSQL="psql -h ... -d <throwaway db with 001..018>" bash 018_concurrency.sh
set -u
Q() { $PSQL -X -tA -v ON_ERROR_STOP=1 "$@"; }
U=00000000-0000-0000-0000-0000000000c1; SH=00000000-0000-0000-0000-0000000000c5
SA=00000000-0000-0000-0000-0000000000ca; SB=00000000-0000-0000-0000-0000000000cb
Q -q <<SQL
insert into auth.users(id) values ('$U');
insert into songs(id, owner_id, song_key, title) values ('$SA','$U','ca','CA'), ('$SB','$U','cb','CB');
insert into shows(id, owner_id, slug, name, config, setlist_migrated) values ('$SH','$U','conc','Conc','{}',true);
insert into setlist_entries(show_id, song_id, position) values ('$SH','$SA',1), ('$SH','$SB',2);
SQL
fail=0
ENTRIES="[{\"song_id\":\"$SA\",\"position\":1},{\"song_id\":\"$SB\",\"position\":2}]"

echo "A. two saves at the same base: exactly one succeeds, the other PT409"
BASE=$(Q -c "select updated_at from shows where id='$SH'")
( Q -c "begin" -c "select rpc_save_show('$SH','{\"by\":1}','C','','','$ENTRIES',null,'$BASE')" -c "select pg_sleep(1.5)" -c "commit" >/dev/null 2>$TMPDIR/a1.err; echo $? > $TMPDIR/a1.rc ) &
sleep 0.4
Q -c "select rpc_save_show('$SH','{\"by\":2}','C','','','$ENTRIES',null,'$BASE')" >/dev/null 2>$TMPDIR/a2.err; echo $? > $TMPDIR/a2.rc
wait
r1=$(cat $TMPDIR/a1.rc); r2=$(cat $TMPDIR/a2.rc)
by=$(Q -c "select config->>'by' from shows where id='$SH'")
if [ "$r1" = 0 ] && [ "$r2" != 0 ] && grep -q "show changed since" $TMPDIR/a2.err && [ "$by" = 1 ]; then echo "  ok (first wins, second refused, stored by=1)"; else echo "  FAIL r1=$r1 r2=$r2 by=$by"; cat $TMPDIR/a2.err; fail=1; fi

echo "B. save holding the show vs rpc_delete_song on a song in it: no deadlock"
BASE=$(Q -c "select updated_at from shows where id='$SH'")
( Q -c "begin" -c "select rpc_save_show('$SH','{\"by\":3}','C','','','$ENTRIES',null,'$BASE')" -c "select pg_sleep(1.5)" -c "commit" >/dev/null 2>$TMPDIR/b1.err; echo $? > $TMPDIR/b1.rc ) &
sleep 0.4
Q -c "select rpc_delete_song('$SB','$U')" >/dev/null 2>$TMPDIR/b2.err; echo $? > $TMPDIR/b2.rc
wait
r1=$(cat $TMPDIR/b1.rc); r2=$(cat $TMPDIR/b2.rc)
if [ "$r1" = 0 ] && [ "$r2" = 0 ] && ! grep -qi deadlock $TMPDIR/b1.err $TMPDIR/b2.err; then echo "  ok (both completed, in turn)"; else echo "  FAIL r1=$r1 r2=$r2"; cat $TMPDIR/b1.err $TMPDIR/b2.err; fail=1; fi

echo "C. rpc_delete_song holding the show vs a save: the save waits, then 409s (version moved)"
Q -q -c "insert into songs(id, owner_id, song_key, title) values ('$SB','$U','cb','CB')" -c "insert into setlist_entries(show_id, song_id, position) values ('$SH','$SB',2)"
BASE=$(Q -c "select updated_at from shows where id='$SH'")
( Q -c "begin" -c "select rpc_delete_song('$SB','$U')" -c "select pg_sleep(1.5)" -c "commit" >/dev/null 2>$TMPDIR/c1.err; echo $? > $TMPDIR/c1.rc ) &
sleep 0.4
Q -c "select rpc_save_show('$SH','{\"by\":4}','C','','','[{\"song_id\":\"$SA\",\"position\":1}]',null,'$BASE')" >/dev/null 2>$TMPDIR/c2.err; echo $? > $TMPDIR/c2.rc
wait
r1=$(cat $TMPDIR/c1.rc); r2=$(cat $TMPDIR/c2.rc)
if [ "$r1" = 0 ] && [ "$r2" != 0 ] && grep -q "show changed since" $TMPDIR/c2.err; then echo "  ok (delete committed; stale save refused, not deadlocked)"; else echo "  FAIL r1=$r1 r2=$r2"; cat $TMPDIR/c1.err $TMPDIR/c2.err; fail=1; fi

[ $fail = 0 ] && echo "ALL PASSED" || { echo "FAILED"; exit 1; }
