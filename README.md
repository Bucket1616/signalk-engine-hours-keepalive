# Engine Run Hours Keepalive

Signal K server plugin that repeats the last known engine run hours
over NMEA2000 when engines stop transmitting.

## Why?

Many chartplotters and MFDs forget engine hours when engines are off.
This plugin keeps the last known value alive without inventing data.

## Features

- Supports up to 6 engines
- Configurable silence delay
- Configurable transmit interval
- Stops immediately when engine resumes transmitting

## Installation

Install via the Signal K Appstore.

## Configuration

- Silence delay (seconds)
- Transmit interval (seconds)
- Maximum engines

## Notes

This plugin does **not** increment run hours.
It only repeats the last valid value received.
