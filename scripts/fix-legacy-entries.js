const { connectToDatabase, closeConnection } = require('../db');

const APPLY = process.argv.includes('--apply');
const COLLECTION = process.env.ENTRIES_COLLECTION || 'entries';

(async () => {
  try {
    console.log(`\n🔧 fix-legacy-entries (${APPLY ? 'APPLY' : 'DRY RUN'})\n`);
    const { db } = await connectToDatabase();
    const entries = db.collection(COLLECTION);

    /* ---- 1. drop the bad index ---- */
    const before = await entries.indexes();
    const bad = before.find((i) => i.name === 'linkId_1');
    if (!bad) {
      console.log('⚪ index linkId_1 already gone');
    } else if (!APPLY) {
      console.log('🟡 would drop index linkId_1:', JSON.stringify(bad.key), JSON.stringify(bad.partialFilterExpression || {}));
    } else {
      await entries.dropIndex('linkId_1');
      console.log('🗑️  dropped index linkId_1');
    }

    /* ---- 2. inspect the legacy rows ---- */
    const legacy = await entries.find({ type: { $exists: false } }).toArray();
    console.log(`\n📋 legacy rows (no \`type\`): ${legacy.length}`);

    const employeeShaped = legacy.filter((e) => e.employeeId && !e.userId);
    const other = legacy.filter((e) => !(e.employeeId && !e.userId));

    console.log(`   employee-shaped (employeeId, no userId): ${employeeShaped.length}`);
    console.log(`   unrecognised shape (left untouched)    : ${other.length}`);
    if (other.length) {
      console.log('   ⚠️  sample:', JSON.stringify(other[0]).slice(0, 300));
    }

    // Guard: (linkId, upiId) must be unique among these before we tag them type 0.
    const seen = new Map();
    const collisions = [];
    for (const e of employeeShaped) {
      const key = `${e.linkId}|${e.upiId}`;
      if (seen.has(key)) collisions.push({ key, ids: [seen.get(key), e._id] });
      else seen.set(key, e._id);
    }
    const existing0 = await entries
      .find({ type: 0 }, { projection: { linkId: 1, upiId: 1 } })
      .toArray();
    const taken = new Set(existing0.map((e) => `${e.linkId}|${e.upiId}`));
    const clashWithLive = [...seen.keys()].filter((k) => taken.has(k));

    if (collisions.length || clashWithLive.length) {
      console.error(
        `\n❌ aborting: ${collisions.length} duplicate (linkId,upiId) pairs among legacy rows, ` +
          `${clashWithLive.length} clash with existing type:0 rows. ` +
          `Resolve these by hand — tagging them type:0 would violate the unique index.`
      );
      collisions.slice(0, 5).forEach((c) => console.error('   dup:', c.key, c.ids));
      clashWithLive.slice(0, 5).forEach((k) => console.error('   clash:', k));
      return;
    }
    console.log('   ✅ no (linkId, upiId) collisions — safe to tag as type 0');

    /* ---- 3. backfill ---- */
    const needStatus = employeeShaped.filter((e) => e.status === undefined).length;
    console.log(`\n📝 would set type: 0 on ${employeeShaped.length} rows`);
    console.log(`📝 would set status: null (pending) on ${needStatus} rows`);
    console.log(
      `   value unlocked for approval: ₹${employeeShaped
        .filter((e) => e.status !== 1)
        .reduce((s, e) => s + Number(e.amount || 0), 0)}`
    );

    const byEmployee = {};
    employeeShaped.forEach((e) => {
      byEmployee[e.employeeId] = (byEmployee[e.employeeId] || 0) + 1;
    });
    console.log('   affected employees:', Object.keys(byEmployee).length);

    if (!APPLY) {
      console.log('\n🟡 dry run — nothing written. Re-run with --apply.\n');
      return;
    }

    const ids = employeeShaped.map((e) => e._id);
    const r1 = await entries.updateMany({ _id: { $in: ids } }, { $set: { type: 0 } });
    const r2 = await entries.updateMany(
      { _id: { $in: ids }, status: { $exists: false } },
      { $set: { status: null } }
    );
    console.log(`\n✅ type set on ${r1.modifiedCount} rows`);
    console.log(`✅ status initialised on ${r2.modifiedCount} rows`);
    console.log('\n✅ done. These entries can now be approved and will debit correctly.\n');
  } catch (err) {
    console.error('❌ failed:', err);
    process.exitCode = 1;
  } finally {
    await closeConnection();
  }
})();
