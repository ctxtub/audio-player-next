import fs from 'fs';
import assert from 'assert';

const agentContent = fs.readFileSync('lib/trpc/routers/agent.ts', 'utf-8');
const ttsContent = fs.readFileSync('lib/trpc/routers/tts.ts', 'utf-8');

assert(!agentContent.includes('interact: publicProcedure'), 'SEC-02: agent.interact should not be publicProcedure');
assert(agentContent.includes('interact: guardedProcedure'), 'SEC-02: agent.interact should be guardedProcedure');

assert(!ttsContent.includes('synthesize: publicProcedure'), 'SEC-02: tts.synthesize should not be publicProcedure');
assert(ttsContent.includes('synthesize: guardedProcedure'), 'SEC-02: tts.synthesize should be guardedProcedure');

console.log('SEC-02: PASS');
