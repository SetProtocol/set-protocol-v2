#!/usr/bin/env bash

cd optimism && cd ops

# Rebuild these since genesis file and dtl get corrupted on repeated use
docker-compose build dtl l2geth
docker-compose up
