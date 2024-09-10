#!/usr/bin/env node
const volume = require('./build/Release/volume.node');
const {spawn} = require('child_process');

let childProcess, oldFreq, freq;

async function main() {
    while (true) {
        freq = volume.getVolume() < 25 ? '19000' : '20700';
        if (freq !== oldFreq || !childProcess || childProcess?.exitCode !== null) {
            if (childProcess?.exitCode === null) {
                childProcess.kill();
            }
            childProcess = spawn('aplay', [`${freq}.wav`]);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        oldFreq = freq;
    }
}

main().catch(console.error);
