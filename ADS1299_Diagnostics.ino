  #include "ADS1299.h"
// #define PLOTTER_MODE true  // set true for Serial Plotter, false for diagnostics
ADS1299 ads;

/***********************************************************************
    SIMPLE STATE FLAGS
************************************************************************/

bool spi_ok = false;
bool id_ok = false;
bool reg_ok = false;
bool write_ok = false;
bool drdy_ok = false;
bool conversion_ok = false;

/***********************************************************************
    SETUP
************************************************************************/
void setup() {
    Serial.begin(115200);
    delay(1000);


    // This block will now be skipped if PLOTTER_MODE is true [4]
    #ifndef PLOTTER_MODE
    Serial.println("======================================");
    Serial.println("     ADS1299 ESP32 DIAGNOSTICS");
    Serial.println("======================================");
    #endif

    if(!ads.begin()) {
        #ifndef PLOTTER_MODE
        Serial.println("SPI INIT FAILED");
        #endif
        while(1);
    }

    ads.begin();
    
    ads.dumpRegisters(Serial);
    
    ads.start();
    ads.enableRDATAC();
        

}
/***********************************************************************
    MAIN LOOP
************************************************************************/

void loop()
{
    // Continuous streaming mode after diagnostics
   // Serial.println("LOOP");
    ads.streamPlotter();
}

/***********************************************************************
    RUN FULL DIAGNOSTIC SUITE
************************************************************************/

void runDiagnostics()
{
    Serial.println();
    Serial.println("STEP 1: DEVICE ID");

    uint8_t id = ads.readID();

    Serial.print("ID = 0x");
    Serial.println(id, HEX);

    if(id == 0x3E)
    {
        Serial.println("ID OK");
        id_ok = true;
    }
    else
    {
        Serial.println("ID FAIL");
    }

    delay(200);

    Serial.println();
    Serial.println("STEP 2: REGISTER DUMP");

    ads.dumpRegisters(Serial);

    reg_ok = ads.verifyRegisters(Serial);

    delay(200);

    Serial.println();
    Serial.println("STEP 3: REGISTER WRITE TEST");

    write_ok = ads.verifyReadWrite(Serial);

    if(write_ok)
        Serial.println("WRITE OK");
    else
        Serial.println("WRITE FAIL");

    delay(200);

    Serial.println();
    Serial.println("STEP 4: RESET + START TEST");

    ads.hardwareReset();
    ads.start();

    delay(100);

    Serial.println();
    Serial.println("STEP 5: DRDY TEST");

    ads.measureDRDY(Serial);

    drdy_ok = ads.countDRDYPulses(500) > 0;

    if(drdy_ok)
        Serial.println("DRDY CHANGING");
    else
        Serial.println("DRDY NOT TOGGLING");

    delay(200);

    Serial.println();
    Serial.println("STEP 6: CONVERSION TEST");

    ads.enableRDATAC();

    delay(100);

    conversion_ok = ads.conversionSelfTest(Serial);

    if(conversion_ok)
        Serial.println("CONVERSION OK");
    else
        Serial.println("CONVERSION FAIL");

    delay(200);

    Serial.println();
    Serial.println("======================================");
    Serial.println("FINAL DIAGNOSIS");
    Serial.println("======================================");

    printFinalDiagnosis();
}

/***********************************************************************
    FINAL DECISION ENGINE
************************************************************************/

void printFinalDiagnosis()
{
    Serial.println();

    if(!spi_ok)
    {
        Serial.println("FAULT: SPI NOT WORKING");
        Serial.println("Check wiring (MOSI/MISO/SCK/CS)");
        return;
    }

    if(!id_ok)
    {
        Serial.println("FAULT: INVALID DEVICE ID");
        Serial.println("Chip not responding correctly on SPI");
        return;
    }

    if(!reg_ok)
    {
        Serial.println("FAULT: REGISTER READ FAILURE");
        Serial.println("SPI partial failure or bus instability");
        return;
    }

    if(!write_ok)
    {
        Serial.println("FAULT: REGISTER WRITE FAILURE");
        Serial.println("MOSI or CS timing issue");
        return;
    }

    if(!drdy_ok)
    {
        Serial.println("FAULT: DRDY NOT TOGGLING");
        Serial.println("LIKELY HARDWARE ISSUE:");
        Serial.println("  START pin LOW or floating");
        Serial.println("  CLKSEL/jumper wrong");
        Serial.println("  Oscillator disabled");
        Serial.println("  RESET held active");
        return;
    }

    if(!conversion_ok)
    {
        Serial.println("FAULT: NO CONVERSION DATA");
        Serial.println("ADS1299 not producing samples");
        Serial.println("Check RDATAC + START sequence");
        return;
    }

    Serial.println("SYSTEM OK");
    Serial.println("STREAMING EEG DATA");
}

/***********************************************************************
    OPTIONAL DEBUG HELPER
************************************************************************/

void printState()
{
    Serial.println();
    Serial.println("---- SYSTEM STATE ----");
    Serial.print("SPI: "); Serial.println(spi_ok);
    Serial.print("ID: "); Serial.println(id_ok);
    Serial.print("REG: "); Serial.println(reg_ok);
    Serial.print("WRITE: "); Serial.println(write_ok);
    Serial.print("DRDY: "); Serial.println(drdy_ok);
    Serial.print("CONV: "); Serial.println(conversion_ok);
    Serial.println("----------------------");
}
