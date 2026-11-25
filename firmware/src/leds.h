// ESPectacle - LED strings, 3D position store, renderer and scan mode
#pragma once
#include <Arduino.h>
#include "settings.h"
#include "effects.h"

void     ledsBegin();            // (re)build strips from cfg and load stored positions
void     ledsTick();             // call from loop(); renders a frame when one is due
uint16_t ledsTotal();
bool     ledsMapped();           // true when real 3D positions are loaded

// Scan mode: everything dark except one LED chosen by the app
void     scanSet(bool on);
bool     scanActive();
bool     scanSolo(int string, int index, uint8_t value);   // index < 0 = all off

void     identifyStart();        // blink each string in its own colour for a few seconds

// Real-time data from DDP (xLights): RGB, 3 bytes per LED in LED order. Shown immediately,
// with the master brightness and current limit applied.
void     ledsShowRealtime(const uint8_t *rgb);

// Geometry upload (see Geo in effects.h). posCommit stores to flash.
bool     posBegin(uint16_t total);
bool     posSet(uint16_t idx, const Geo &g);
bool     posCommit(uint32_t baseIndex, uint32_t geoId);
uint32_t posId();                // id the app gave the stored geometry (0 = none)
void     posClear();
