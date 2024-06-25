const voicemeeter = require('voicemeeter-remote');

async function main() {
  // Initialize Voicemeeter
  await voicemeeter.init();

  // Connect to Voicemeeter
  await voicemeeter.login();

  // Update state from Voicemeeter
  await voicemeeter.updateDeviceList();

  // Get the initial state
  console.log('Initial state:', {
    inputDevices: voicemeeter.inputDevices,
    outputDevices: voicemeeter.outputDevices,
  });

  // Set master bus volume to -10 dB
  await voicemeeter.setBusGain(1, +10);

  // Log the new state to confirm the change
  await voicemeeter.updateDeviceList();
  console.log('Updated state:', {
    inputDevices: voicemeeter.inputDevices,
    outputDevices: voicemeeter.outputDevices,
  });

  // Logout from Voicemeeter
  await voicemeeter.logout();

}

main().catch(console.error);
