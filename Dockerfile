FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-dev \
    build-essential \
    libgdal-dev \
    git \
    gdal-bin \
    python3-gdal \
    python3-scipy \
    && rm -rf /var/lib/apt/lists/*

# The rasterio based tools and the GDAL Python bindings cannot share a
# site-packages directory: apt installs numpy as a Debian package, which pip
# then refuses to replace ("Cannot uninstall numpy, RECORD file not found").
# Keep them apart. gdal2NPtiles.py and gdal_calc.py need the system python3
# for osgeo; rio and mb-util get their own virtualenv with a PyPI rasterio.
ENV VENV=/opt/rio
RUN python3 -m venv $VENV && $VENV/bin/pip install --upgrade pip

WORKDIR /app

# Pin external tools to specific commits for reproducible builds.
ARG MBUTIL_REF=544c76eea925e3c1bc129f601e314ea9701bfc79
ARG RIO_RGBIFY_REF=a05815d14e0c3dcec4f8509c8d0def578c164eea
ARG RIO_TERRARIUM_REF=73ad83b098326b5d88cdade8e77aef1061c8485b
ARG GDAL2NPTILES_REF=4eaccba50f67f067143d0caebc7f6d4be1f1884c

RUN git clone https://github.com/mapbox/mbutil.git \
    && cd mbutil \
    && git checkout ${MBUTIL_REF} \
    && $VENV/bin/pip install .

RUN git clone https://github.com/mapbox/rio-rgbify.git \
    && cd rio-rgbify \
    && git checkout ${RIO_RGBIFY_REF} \
    && $VENV/bin/pip install .

# rio-terrarium declares requires-python >=3.13, which is what uv writes into
# a new pyproject rather than a real constraint: none of its dependencies
# (click, mercantile, pillow, rasterio, rio-mucho) need 3.13, and the only code
# change since the setup.py era is one densify_pts argument. Ubuntu 24.04 ships
# 3.12, so relax the marker instead of pinning to the older revision and losing
# the current-rasterio fix.
RUN git clone https://github.com/smellman/rio-terrarium.git \
    && cd rio-terrarium \
    && git checkout ${RIO_TERRARIUM_REF} \
    && sed -i 's/^requires-python = ">=3.13"/requires-python = ">=3.12"/' pyproject.toml \
    && $VENV/bin/pip install .

RUN git clone https://github.com/smellman/gdal2NPtiles.git \
    && cd gdal2NPtiles \
    && git checkout ${GDAL2NPTILES_REF} \
    && cp gdal2NPtiles.py /usr/local/bin/ \
    && chmod +x /usr/local/bin/gdal2NPtiles.py

# Appended, not prepended: `python3` must stay the system interpreter that has
# osgeo, while `rio` and `mb-util` resolve to the virtualenv.
ENV PATH="$PATH:/opt/rio/bin"

COPY probe.py tile_driver.py docker_entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker_entrypoint.sh /usr/local/bin/probe.py /usr/local/bin/tile_driver.py
ENTRYPOINT [ "/usr/local/bin/docker_entrypoint.sh" ]
