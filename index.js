#!/usr/bin/env node
const volume = require('./build/Release/volume.node');
const {spawn} = require('child_process');

let childProcess, oldFreq, freq;

async function main() {
    let vol, prevVol;
    while (true) {
        vol = volume.getVolume();
        if (vol !== prevVol) {
            console.log(`${vol}% volume`);
            prevVol = vol;
        }

        freq = vol < 25 ? '19000' : '20700';
        if (freq !== oldFreq) {
            if (childProcess) {
                childProcess.kill();
            }

            childProcess = spawn('aplay', [`${freq}.wav`]);
            oldFreq = freq;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

main().catch(console.error);
