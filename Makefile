.PHONY: all crawl aux build serve clean

all: crawl aux build

crawl:
	python3 pipeline/crawl.py

aux:
	python3 pipeline/fetch_aux.py

build:
	python3 pipeline/build.py

serve: build
	cd site && python3 -m http.server 8777

clean:
	rm -rf raw site/data
