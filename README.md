# LoRa HackRF check

This script reports likely RF transmissions on a tuned LoRa channel. It uses
HackRF One through the `hackrf_transfer` command and does not decode packets.

## Raspberry Pi setup

On Raspberry Pi OS:

```sh
sudo apt update
sudo apt install -y nodejs npm hackrf
git clone <your-repository-url>
cd Lora2
npm run check -- --frequency 915000000 --duration 60
```

If the Pi user cannot access the USB device, run the command once with `sudo`
to confirm it is a permissions issue, then install the HackRF udev rules or
add the user to the group used by your Raspberry Pi OS image. The script also
accepts an explicit executable path with `--hackrf /path/to/hackrf_transfer`.

```sh
npm run check -- --frequency 915000000 --duration 60
```

The default frequency is `868.1 MHz`. Set it to the exact center frequency of
the LoRa gateway or node you are checking. Keep the antenna connected and use
the lowest gain that gives a stable noise floor; very strong nearby signals can
otherwise overload the HackRF.

The result is an RF activity indication, not proof of a valid LoRa packet. Use
the exact channel frequency and expect false positives from other signals in
the receiver bandwidth.