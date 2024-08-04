#!/usr/bin/env node
const volume = require('./build/Release/volume.node');
const nodeWebAudioApi = require('node-web-audio-api');

async function main() {
    const AudioContext = nodeWebAudioApi.AudioContext;
    const context = new AudioContext();

    const lowFreqOscillator = context.createOscillator();
    lowFreqOscillator.frequency.setValueAtTime(19000, context.currentTime);

    const hiFreqOscillator = context.createOscillator();
    hiFreqOscillator.frequency.setValueAtTime(20913, context.currentTime);

    hiFreqOscillator.start();
    lowFreqOscillator.start();

    let oscillator, prevOscillator;
    let vol, prevVol;
    while (true) {
        vol = volume.getVolume();
        if (vol !== prevVol) {
            console.log(`${vol}% volume`);
        }
        prevVol = vol;

        oscillator = vol < 25 ? lowFreqOscillator : hiFreqOscillator;
        if (oscillator !== prevOscillator) {
            if (prevOscillator) {
                prevOscillator.disconnect(context.destination);
            }
            oscillator.connect(context.destination);
            prevOscillator = oscillator;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

main().catch(console.error);
