@echo off
rem PATH shim for cloudtest (PowerShell / cmd): runs cloudtest.js from this checkout.
node "%~dp0..\cloudtest.js" %*
