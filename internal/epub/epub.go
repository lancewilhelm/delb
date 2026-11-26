package epub

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/beevik/etree"
)

const (
	epubMimetype = "application/epub+zip"
	containerNS  = "urn:oasis:names:tc:opendocument:xmlns:container"
	opfNS        = "http://www.idpf.org/2007/opf"
	dcNS         = "http://purl.org/dc/elements/1.1/"
	xhtmlNS      = "http://www.w3.org/1999/xhtml"
	svgNS        = "http://www.w3.org/2000/svg"
	dtbookNS     = "http://www.daisy.org/z3986/2005/dtbook/"
)

var (
	repairableMimetypeRe = regexp.MustCompile(`^\x{FEFF}?[\t\r\n ]*(?:application/epub\+zip)?[\t\r\n ]*$`)
	calibrePrefixRe      = regexp.MustCompile(`(^|\s)calibre\s*:`)
	whitespaceRe         = regexp.MustCompile(`\s+`)
)

// Metadata mirrors server/utils/books/epub.ts EpubMetadata.
type Metadata struct {
	Title       string
	Author      string
	Description string
	Language    string
	Identifier  string
	Publisher   string
	Published   string
	Subject     string
	Subjects    []string
	ISBN        string
	UUID        string
}

// CoverInspection mirrors packages/epub/src/types.ts CoverInspection.
type CoverInspection struct {
	EpubVersion   int
	ImagePath     string
	ImageID       string
	MediaType     string
	TitlePagePath string
	Source        string
	ImageData     []byte
}

// CoverMutationOptions mirrors packages/epub/src/types.ts CoverMutationOptions.
type CoverMutationOptions struct {
	Limits          *ArchiveLimits
	RepairMimetype  bool
	KeepAspectRatio *bool
}

// CoverMutationResult mirrors packages/epub/src/types.ts CoverMutationResult.
type CoverMutationResult struct {
	Data             []byte
	Action           string
	Cover            *CoverInspection
	Warnings         []string
	MimetypeRepaired bool
}

type manifestItem struct {
	elem       *etree.Element
	id         string
	href       string
	path       string
	mediaType  string
	properties []string
}

type epubDocument struct {
	files            map[string][]byte
	containerDoc     *etree.Document
	opfDoc           *etree.Document
	opfPath          string
	rootDir          string
	version          int
	packageElem      *etree.Element
	metadataElem     *etree.Element
	manifestElem     *etree.Element
	spineElem        *etree.Element
	mimetypeRepaired bool
}

// ParseMetadataFromBytes mirrors server/utils/books/epub.ts parseEpubMetadataFromBuffer.
func ParseMetadataFromBytes(input []byte, fallbackTitle string) (Metadata, error) {
	if len(input) > 100*1024*1024 {
		return Metadata{}, errors.New("EPUB exceeds the 100 MiB file limit")
	}
	fallbackTitle = strings.TrimSpace(fallbackTitle)
	if fallbackTitle == "" {
		fallbackTitle = "Untitled"
	}
	files, err := ReadArchive(input, &UploadArchiveLimits)
	if err != nil {
		return Metadata{}, err
	}
	opfDoc, _, err := loadOPFFromFiles(files)
	if err != nil {
		return Metadata{}, err
	}
	pkg := opfDoc.Root()
	if pkg == nil {
		return Metadata{}, invalidEpub("OPF document does not have a package root element", nil)
	}
	metaElem := findChildByLocalName(pkg, "metadata")

	var out Metadata
	if metaElem != nil {
		out.Title = firstTextByLocalName(metaElem, "title")
		out.Author = firstCreator(metaElem)
		out.Description = firstTextByLocalName(metaElem, "description")
		out.Language = firstTextByLocalName(metaElem, "language")
		out.Publisher = firstTextByLocalName(metaElem, "publisher")
		out.Subject = firstTextByLocalName(metaElem, "subject")
		seenSubj := make(map[string]struct{})
		for _, el := range findAllByLocalName(metaElem, "subject") {
			val := strings.TrimSpace(el.Text())
			if val == "" {
				continue
			}
			key := strings.ToLower(val)
			if _, ok := seenSubj[key]; ok {
				continue
			}
			seenSubj[key] = struct{}{}
			out.Subjects = append(out.Subjects, val)
		}
		out.Published = firstTextByLocalName(metaElem, "date")

		for _, el := range findAllByLocalName(metaElem, "identifier") {
			val := strings.TrimSpace(el.Text())
			if val == "" {
				continue
			}
			if out.Identifier == "" {
				out.Identifier = val
			}
			scheme := strings.ToLower(strings.TrimSpace(attrByLocalName(el, "scheme")))
			lowerVal := strings.ToLower(val)
			if out.ISBN == "" && (scheme == "isbn" || strings.HasPrefix(lowerVal, "urn:isbn:")) {
				out.ISBN = strings.TrimPrefix(strings.TrimPrefix(val, "urn:isbn:"), "URN:ISBN:")
			}
			if out.UUID == "" && (scheme == "uuid" || strings.HasPrefix(lowerVal, "urn:uuid:")) {
				out.UUID = strings.TrimPrefix(strings.TrimPrefix(val, "urn:uuid:"), "URN:UUID:")
			}
		}
	}
	if out.Title == "" {
		out.Title = fallbackTitle
	}
	if out.Author == "" {
		out.Author = "Unknown Author"
	}
	return out, nil
}

// ExtractCoverFromBytes extracts the best-effort cover image bytes and MIME type
// from an EPUB byte slice (mirroring server/utils/books/epub-cover.ts).
func ExtractCoverFromBytes(input []byte) (bytesOut []byte, mimeType string, ok bool, err error) {
	if len(input) > 100*1024*1024 {
		return nil, "", false, errors.New("EPUB exceeds the 100 MiB file limit")
	}
	files, err := ReadArchive(input, &UploadArchiveLimits)
	if err != nil {
		return nil, "", false, err
	}
	opfDoc, opfPath, err := loadOPFFromFiles(files)
	if err != nil {
		return nil, "", false, err
	}
	pkg := opfDoc.Root()
	if pkg == nil {
		return nil, "", false, nil
	}
	metaElem := findChildByLocalName(pkg, "metadata")
	manifestElem := findChildByLocalName(pkg, "manifest")
	if manifestElem == nil {
		return nil, "", false, nil
	}

	items := parseManifestItems(manifestElem, opfPath)
	byID := make(map[string]manifestItem, len(items))
	for _, it := range items {
		byID[it.id] = it
	}

	// 1. EPUB 3 cover-image property
	for _, it := range items {
		if hasProp(it.properties, "cover-image") && strings.HasPrefix(strings.ToLower(it.mediaType), "image/") {
			if data, exists := files[it.path]; exists && len(data) > 0 {
				return data, it.mediaType, true, nil
			}
		}
	}
	// 2. EPUB 2 <meta name="cover" content="..."/>
	if metaElem != nil {
		for _, m := range findAllByLocalName(metaElem, "meta") {
			if m.SelectAttrValue("name", "") != "cover" {
				continue
			}
			ref := strings.TrimSpace(m.SelectAttrValue("content", ""))
			if ref == "" {
				continue
			}
			if it, found := byID[ref]; found && strings.HasPrefix(strings.ToLower(it.mediaType), "image/") {
				if data, exists := files[it.path]; exists && len(data) > 0 {
					return data, it.mediaType, true, nil
				}
			}
			for _, it := range items {
				if it.href == ref && strings.HasPrefix(strings.ToLower(it.mediaType), "image/") {
					if data, exists := files[it.path]; exists && len(data) > 0 {
						return data, it.mediaType, true, nil
					}
				}
			}
		}
	}
	// 3. Score manifest image candidates
	type scored struct {
		item  manifestItem
		score int
	}
	var cands []scored
	for _, it := range items {
		mt := strings.ToLower(it.mediaType)
		if !strings.HasPrefix(mt, "image/") {
			continue
		}
		score := 0
		idL := strings.ToLower(it.id)
		hrefL := strings.ToLower(it.href)
		if strings.Contains(idL, "cover") {
			score += 5
		}
		if strings.Contains(hrefL, "cover") {
			score += 5
		}
		if strings.Contains(hrefL, "front") {
			score += 2
		}
		if strings.Contains(hrefL, "thumbnail") {
			score -= 2
		}
		if strings.Contains(mt, "jpeg") || strings.Contains(mt, "jpg") {
			score += 2
		}
		if strings.Contains(mt, "png") {
			score += 1
		}
		if strings.Contains(mt, "svg") {
			score -= 3
		}
		if strings.Contains(mt, "gif") {
			score -= 2
		}
		if score > 0 {
			cands = append(cands, scored{item: it, score: score})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		return cands[i].score > cands[j].score
	})
	for _, c := range cands {
		if data, exists := files[c.item.path]; exists && len(data) > 0 {
			return data, c.item.mediaType, true, nil
		}
	}
	return nil, "", false, nil
}

// InspectCover mirrors packages/epub/src/cover.ts inspectCover.
func InspectCover(input []byte, limits *ArchiveLimits) (*CoverInspection, error) {
	doc, err := readEpub(input, limits, false)
	if err != nil {
		return nil, err
	}
	return inspectDocumentCover(doc), nil
}

// SetCover mirrors packages/epub/src/cover.ts setCover.
func SetCover(input []byte, coverData []byte, mediaType string, opts CoverMutationOptions) (*CoverMutationResult, error) {
	if err := validateCoverInput(coverData, mediaType); err != nil {
		return nil, err
	}
	doc, err := readEpub(input, opts.Limits, opts.RepairMimetype)
	if err != nil {
		return nil, err
	}
	if _, signed := doc.files["META-INF/signatures.xml"]; signed {
		return nil, &Error{
			Code:    ErrSignedEpub,
			Message: "Signed EPUBs cannot be modified without invalidating their signatures",
		}
	}
	existing := inspectDocumentCover(doc)
	if existing != nil && isPathEncrypted(doc, existing.ImagePath) {
		return nil, &Error{
			Code:    ErrEncryptedCover,
			Message: fmt.Sprintf("The existing cover resource is encrypted: %s", existing.ImagePath),
		}
	}

	warnings := make([]string, 0)
	if doc.mimetypeRepaired {
		warnings = append(warnings, "Normalized the missing or noncanonical EPUB mimetype entry.")
	}
	ext := "jpg"
	if mediaType == "image/png" {
		ext = "png"
	}
	canReuse := existing != nil &&
		((mediaType == "image/png" && strings.HasSuffix(strings.ToLower(existing.ImagePath), ".png")) ||
			(mediaType == "image/jpeg" && (strings.HasSuffix(strings.ToLower(existing.ImagePath), ".jpg") || strings.HasSuffix(strings.ToLower(existing.ImagePath), ".jpeg"))))

	preferredImagePath, err := archiveJoin(doc.rootDir, "images", "cover."+ext)
	if err != nil {
		return nil, err
	}
	imagePath := preferredImagePath
	if canReuse {
		imagePath = existing.ImagePath
	} else {
		imagePath = uniqueArchivePath(doc.files, preferredImagePath)
	}
	if existing != nil && imagePath != existing.ImagePath {
		warnings = append(warnings, fmt.Sprintf("Retained the previous cover resource at %s because the replacement uses a different media type.", existing.ImagePath))
	}
	doc.files[imagePath] = append([]byte(nil), coverData...)

	preferredID := "cover-image"
	if existing != nil && existing.ImageID != "" {
		preferredID = existing.ImageID
	}
	imageItem := ensureManifestItem(doc, imagePath, mediaType, preferredID)
	normalizeCoverMarkers(doc, imageItem)

	keepAspect := true
	if opts.KeepAspectRatio != nil {
		keepAspect = *opts.KeepAspectRatio
	}

	var titlePagePath string
	if existing != nil {
		titlePagePath = existing.TitlePagePath
	}
	if titlePagePath != "" && simpleCoverImagePath(doc, titlePagePath) != "" {
		updateSimpleCoverPage(doc, titlePagePath, imagePath)
	} else {
		if titlePagePath != "" {
			warnings = append(warnings, fmt.Sprintf("Preserved complex title page %s and inserted a dedicated cover title page.", titlePagePath))
		}
		preferredTitle, err := archiveJoin(doc.rootDir, "titlepage.xhtml")
		if err != nil {
			return nil, err
		}
		titlePagePath = uniqueArchivePath(doc.files, preferredTitle)
		doc.files[titlePagePath] = createTitlePage(relativeHref(titlePagePath, imagePath), keepAspect)
	}
	titleItem := ensureManifestItem(doc, titlePagePath, "application/xhtml+xml", "cover-titlepage")
	normalizeTitlePage(doc, titleItem, imageItem)

	opfBytes, err := serializeXML(doc.opfDoc)
	if err != nil {
		return nil, err
	}
	doc.files[doc.opfPath] = opfBytes

	outData, err := WriteArchive(doc.files)
	if err != nil {
		return nil, err
	}
	verified, err := InspectCover(outData, opts.Limits)
	if err != nil {
		return nil, err
	}
	if verified == nil {
		return nil, &Error{
			Code:    ErrInvalidEpub,
			Message: "Cover mutation completed without a detectable output cover",
		}
	}
	action := "inserted"
	if existing != nil {
		if existing.Source == "guide" || existing.Source == "first-spine" {
			action = "repaired"
		} else {
			action = "replaced"
		}
	}
	return &CoverMutationResult{
		Data:             outData,
		Action:           action,
		Cover:            verified,
		Warnings:         warnings,
		MimetypeRepaired: doc.mimetypeRepaired,
	}, nil
}

func validateCoverInput(data []byte, mediaType string) error {
	if len(data) == 0 {
		return &Error{Code: ErrUnsupportedImage, Message: "Cover data must be a non-empty byte slice"}
	}
	isPNG := len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	isJPEG := len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff
	if (mediaType == "image/png" && !isPNG) || (mediaType == "image/jpeg" && !isJPEG) {
		return &Error{Code: ErrUnsupportedImage, Message: "Cover bytes do not match " + mediaType}
	}
	return nil
}

func loadOPFFromFiles(files map[string][]byte) (*etree.Document, string, error) {
	containerBytes, ok := files["META-INF/container.xml"]
	if !ok {
		return nil, "", invalidEpub("META-INF/container.xml is missing", nil)
	}
	containerDoc, err := parseXML(containerBytes, "META-INF/container.xml")
	if err != nil {
		return nil, "", err
	}
	rootfiles := findAllByLocalName(containerDoc.Root(), "rootfile")
	var chosen *etree.Element
	for _, rf := range rootfiles {
		if rf.SelectAttrValue("media-type", "") == "application/oebps-package+xml" {
			chosen = rf
			break
		}
	}
	if chosen == nil {
		for _, rf := range rootfiles {
			if rf.SelectAttr("full-path") != nil {
				chosen = rf
				break
			}
		}
	}
	if chosen == nil {
		return nil, "", invalidEpub("EPUB container does not declare an OPF rootfile", nil)
	}
	declaredPath := chosen.SelectAttrValue("full-path", "")
	if declaredPath == "" {
		return nil, "", invalidEpub("EPUB container does not declare an OPF rootfile", nil)
	}
	opfPath, err := resolveHref("root", declaredPath)
	if err != nil {
		return nil, "", err
	}
	opfBytes, ok := files[opfPath]
	if !ok {
		return nil, "", invalidEpub("Declared OPF rootfile is missing: "+opfPath, nil)
	}
	opfDoc, err := parseXML(opfBytes, opfPath)
	if err != nil {
		return nil, "", err
	}
	return opfDoc, opfPath, nil
}

func readEpub(input []byte, limits *ArchiveLimits, repairMimetype bool) (*epubDocument, error) {
	files, err := ReadArchive(input, limits)
	if err != nil {
		return nil, err
	}
	mimetype, hasMime := files["mimetype"]
	if (!hasMime || string(mimetype) != epubMimetype) && !(repairMimetype && isRepairableMimetype(mimetype, hasMime)) {
		return nil, invalidEpub("EPUB mimetype is missing or invalid", nil)
	}
	containerBytes, ok := files["META-INF/container.xml"]
	if !ok {
		return nil, invalidEpub("META-INF/container.xml is missing", nil)
	}
	containerDoc, err := parseXML(containerBytes, "META-INF/container.xml")
	if err != nil {
		return nil, err
	}
	rootfiles := findAllByLocalName(containerDoc.Root(), "rootfile")
	var rootfile *etree.Element
	for _, rf := range rootfiles {
		if rf.SelectAttrValue("media-type", "") == "application/oebps-package+xml" {
			rootfile = rf
			break
		}
	}
	if rootfile == nil {
		for _, rf := range rootfiles {
			if rf.SelectAttr("full-path") != nil {
				rootfile = rf
				break
			}
		}
	}
	if rootfile == nil || rootfile.SelectAttrValue("full-path", "") == "" {
		return nil, invalidEpub("EPUB container does not declare an OPF rootfile", nil)
	}
	opfPath, err := resolveHref("root", rootfile.SelectAttrValue("full-path", ""))
	if err != nil {
		return nil, err
	}
	opfBytes, ok := files[opfPath]
	if !ok {
		return nil, invalidEpub("Declared OPF rootfile is missing: "+opfPath, nil)
	}
	opfDoc, err := parseXML(opfBytes, opfPath)
	if err != nil {
		return nil, err
	}
	pkg := opfDoc.Root()
	if pkg == nil || pkg.Tag != "package" {
		return nil, invalidEpub("OPF document does not have a package root element", nil)
	}
	metaElem := findChildByLocalName(pkg, "metadata")
	manifestElem := findChildByLocalName(pkg, "manifest")
	spineElem := findChildByLocalName(pkg, "spine")
	if metaElem == nil || manifestElem == nil || spineElem == nil {
		return nil, invalidEpub("OPF document must contain metadata, manifest, and spine elements", nil)
	}
	rawVersion := pkg.SelectAttrValue("version", "")
	version := 0
	if strings.HasPrefix(rawVersion, "2") {
		version = 2
	} else if strings.HasPrefix(rawVersion, "3") {
		version = 3
	} else {
		disp := rawVersion
		if disp == "" {
			disp = "<missing>"
		}
		return nil, invalidEpub("Unsupported EPUB package version: "+disp, nil)
	}

	doc := &epubDocument{
		files:        files,
		containerDoc: containerDoc,
		opfDoc:       opfDoc,
		opfPath:      opfPath,
		rootDir:      archiveDirname(opfPath),
		version:      version,
		packageElem:  pkg,
		metadataElem: metaElem,
		manifestElem: manifestElem,
		spineElem:    spineElem,
	}

	if repairMimetype && (!hasMime || string(mimetype) != epubMimetype) {
		if err := validateMimetypeRepair(doc, rootfile); err != nil {
			return nil, err
		}
		if isPathEncrypted(doc, "mimetype") {
			return nil, invalidEpub("Encrypted EPUB mimetype cannot be normalized", nil)
		}
		files["mimetype"] = []byte(epubMimetype)
		doc.mimetypeRepaired = true
	}
	return doc, nil
}

func isRepairableMimetype(data []byte, present bool) bool {
	if !present {
		return true
	}
	if len(data) > 128 {
		return false
	}
	if !utf8.Valid(data) {
		return false
	}
	return repairableMimetypeRe.Match(data)
}

func validateMimetypeRepair(doc *epubDocument, rootfile *etree.Element) error {
	container := doc.containerDoc.Root()
	rfs := findChildByLocalName(container, "rootfiles")
	pkgVer := doc.packageElem.SelectAttrValue("version", "")
	if container == nil ||
		container.Tag != "container" ||
		elementNS(container) != containerNS ||
		container.SelectAttrValue("version", "") != "1.0" ||
		rfs == nil || elementNS(rfs) != containerNS ||
		rootfile == nil || rootfile.Parent() != rfs || elementNS(rootfile) != containerNS ||
		rootfile.SelectAttrValue("media-type", "") != "application/oebps-package+xml" ||
		elementNS(doc.packageElem) != opfNS ||
		(pkgVer != "2.0" && pkgVer != "3.0") ||
		elementNS(doc.metadataElem) != opfNS ||
		elementNS(doc.manifestElem) != opfNS ||
		elementNS(doc.spineElem) != opfNS {
		return invalidEpub("Cannot normalize mimetype without a valid EPUB container and package", nil)
	}

	uniqueID := doc.packageElem.SelectAttrValue("unique-identifier", "")
	for _, name := range []string{"identifier", "title", "language"} {
		found := false
		for _, el := range findAllByLocalName(doc.metadataElem, name) {
			if elementNS(el) != dcNS || strings.TrimSpace(el.Text()) == "" {
				continue
			}
			if name == "identifier" && (uniqueID == "" || el.SelectAttrValue("id", "") != uniqueID) {
				continue
			}
			found = true
			break
		}
		if !found {
			return invalidEpub("Cannot normalize mimetype without EPUB identifier, title, and language metadata", nil)
		}
	}

	items := parseManifestItems(doc.manifestElem, doc.opfPath)
	ids := make(map[string]struct{}, len(items))
	for _, it := range items {
		if elementNS(it.elem) != opfNS || it.id == "" || it.href == "" || it.elem.SelectAttrValue("media-type", "") == "" {
			return invalidEpub("Cannot normalize mimetype with an invalid manifest or missing local resource", nil)
		}
		if _, dup := ids[it.id]; dup {
			return invalidEpub("Cannot normalize mimetype with an invalid manifest or missing local resource", nil)
		}
		if _, exists := doc.files[it.path]; !exists {
			return invalidEpub("Cannot normalize mimetype with an invalid manifest or missing local resource", nil)
		}
		ids[it.id] = struct{}{}
	}

	spine := getSpinePaths(doc)
	if len(spine) == 0 {
		return invalidEpub("Cannot normalize mimetype without EPUB reading content", nil)
	}
	for _, sp := range spine {
		if elementNS(sp.itemref) != opfNS || sp.item == nil {
			return invalidEpub("Cannot normalize mimetype with an invalid EPUB spine", nil)
		}
		d, err := parseXML(doc.files[sp.item.path], sp.item.path)
		if err != nil {
			return err
		}
		root := d.Root()
		valid := root != nil &&
			((sp.item.mediaType == "application/xhtml+xml" && root.Tag == "html" && elementNS(root) == xhtmlNS) ||
				(sp.item.mediaType == "image/svg+xml" && root.Tag == "svg" && elementNS(root) == svgNS) ||
				(sp.item.mediaType == "application/x-dtbook+xml" && root.Tag == "dtbook" && elementNS(root) == dtbookNS))
		if !valid {
			return invalidEpub("Cannot normalize mimetype without recognized EPUB reading documents", nil)
		}
	}
	return nil
}

func parseManifestItems(manifestElem *etree.Element, opfPath string) []manifestItem {
	elems := findAllByLocalName(manifestElem, "item")
	out := make([]manifestItem, 0, len(elems))
	for _, el := range elems {
		id := el.SelectAttrValue("id", "")
		href := el.SelectAttrValue("href", "")
		mt := el.SelectAttrValue("media-type", "application/octet-stream")
		props := strings.Fields(el.SelectAttrValue("properties", ""))
		p, err := resolveHref(opfPath, href)
		if err != nil {
			continue
		}
		out = append(out, manifestItem{
			elem:       el,
			id:         id,
			href:       href,
			path:       p,
			mediaType:  mt,
			properties: props,
		})
	}
	return out
}

type spineEntry struct {
	itemref *etree.Element
	item    *manifestItem
}

func getSpinePaths(doc *epubDocument) []spineEntry {
	items := parseManifestItems(doc.manifestElem, doc.opfPath)
	byID := make(map[string]manifestItem, len(items))
	for _, it := range items {
		byID[it.id] = it
	}
	refs := findAllByLocalName(doc.spineElem, "itemref")
	out := make([]spineEntry, 0, len(refs))
	for _, ref := range refs {
		idref := ref.SelectAttrValue("idref", "")
		var ptr *manifestItem
		if it, ok := byID[idref]; ok {
			copyIt := it
			ptr = &copyIt
		}
		out = append(out, spineEntry{itemref: ref, item: ptr})
	}
	return out
}

func isImageItem(it *manifestItem) bool {
	return it != nil && strings.HasPrefix(strings.ToLower(it.mediaType), "image/")
}

func simpleCoverImagePath(doc *epubDocument, pagePath string) string {
	data, ok := doc.files[pagePath]
	if !ok {
		return ""
	}
	d, err := parseXML(data, pagePath)
	if err != nil || d.Root() == nil {
		return ""
	}
	body := d.Root()
	if bodies := findAllByLocalName(d.Root(), "body"); len(bodies) > 0 {
		body = bodies[0]
	}
	imgs := append(findAllByLocalName(body, "img"), findAllByLocalName(body, "image")...)
	if len(imgs) != 1 {
		return ""
	}
	if strings.TrimSpace(whitespaceRe.ReplaceAllString(collectText(body), "")) != "" {
		return ""
	}
	href := imgs[0].SelectAttrValue("src", "")
	if href == "" {
		href = imgs[0].SelectAttrValue("href", "")
	}
	if href == "" {
		href = attrByLocalName(imgs[0], "href")
	}
	if href == "" {
		return ""
	}
	p, err := resolveHref(pagePath, href)
	if err != nil {
		return ""
	}
	return p
}

func inspectDocumentCover(doc *epubDocument) *CoverInspection {
	items := parseManifestItems(doc.manifestElem, doc.opfPath)
	byID := make(map[string]manifestItem, len(items))
	for _, it := range items {
		byID[it.id] = it
	}
	makeCover := func(it *manifestItem, source, titlePage string) *CoverInspection {
		if !isImageItem(it) {
			return nil
		}
		data, ok := doc.files[it.path]
		if !ok {
			return nil
		}
		return &CoverInspection{
			EpubVersion:   doc.version,
			ImagePath:     it.path,
			ImageID:       it.id,
			MediaType:     it.mediaType,
			TitlePagePath: titlePage,
			Source:        source,
			ImageData:     data,
		}
	}

	if doc.version == 3 {
		for _, it := range items {
			if hasProp(it.properties, "cover-image") {
				cp := it
				if res := makeCover(&cp, "epub3-property", findTitlePage(doc, items)); res != nil {
					return res
				}
			}
		}
	}

	for _, meta := range findAllByLocalName(doc.metadataElem, "meta") {
		if meta.SelectAttrValue("name", "") != "cover" {
			continue
		}
		if it, ok := byID[meta.SelectAttrValue("content", "")]; ok {
			if res := makeCover(&it, "epub2-meta", findTitlePage(doc, items)); res != nil {
				return res
			}
		}
	}

	for _, ref := range findAllByLocalName(doc.packageElem, "reference") {
		if !strings.EqualFold(ref.SelectAttrValue("type", ""), "cover") {
			continue
		}
		href := ref.SelectAttrValue("href", "")
		if href == "" {
			continue
		}
		targetPath, err := resolveHref(doc.opfPath, href)
		if err != nil {
			continue
		}
		for _, it := range items {
			if it.path == targetPath {
				cp := it
				if res := makeCover(&cp, "guide", ""); res != nil {
					return res
				}
			}
		}
		if imgPath := simpleCoverImagePath(doc, targetPath); imgPath != "" {
			for _, it := range items {
				if it.path == imgPath {
					cp := it
					if res := makeCover(&cp, "guide", targetPath); res != nil {
						return res
					}
				}
			}
		}
	}

	spine := getSpinePaths(doc)
	if len(spine) > 0 && spine[0].item != nil {
		first := spine[0].item
		var imgPath, titlePage string
		if isImageItem(first) {
			imgPath = first.path
		} else {
			imgPath = simpleCoverImagePath(doc, first.path)
			titlePage = first.path
		}
		if imgPath != "" {
			for _, it := range items {
				if it.path == imgPath {
					cp := it
					if res := makeCover(&cp, "first-spine", titlePage); res != nil {
						return res
					}
				}
			}
		}
	}
	return nil
}

func findTitlePage(doc *epubDocument, items []manifestItem) string {
	for _, it := range items {
		if hasProp(it.properties, "calibre:title-page") {
			return it.path
		}
	}
	for _, ref := range findAllByLocalName(doc.packageElem, "reference") {
		if !strings.EqualFold(ref.SelectAttrValue("type", ""), "cover") {
			continue
		}
		href := ref.SelectAttrValue("href", "")
		if href == "" {
			continue
		}
		p, err := resolveHref(doc.opfPath, href)
		if err != nil {
			continue
		}
		for _, it := range items {
			if it.path == p && it.mediaType == "application/xhtml+xml" {
				return p
			}
		}
	}
	return ""
}

func isPathEncrypted(doc *epubDocument, targetPath string) bool {
	enc, ok := doc.files["META-INF/encryption.xml"]
	if !ok {
		return false
	}
	d, err := parseXML(enc, "META-INF/encryption.xml")
	if err != nil || d.Root() == nil {
		return false
	}
	for _, ref := range findAllByLocalName(d.Root(), "CipherReference") {
		uri := ref.SelectAttrValue("URI", "")
		if uri == "" {
			continue
		}
		if resolved, err := resolveHref("root", uri); err == nil && resolved == targetPath {
			return true
		}
	}
	return false
}

func ensureManifestItem(doc *epubDocument, targetPath, mediaType, preferredID string) manifestItem {
	items := parseManifestItems(doc.manifestElem, doc.opfPath)
	var item *manifestItem
	for i := range items {
		if items[i].path == targetPath {
			item = &items[i]
			break
		}
	}
	if item == nil {
		el := createOpfChild(doc.manifestElem, "item")
		item = &manifestItem{elem: el, path: targetPath, mediaType: mediaType}
	}
	usedIDs := make(map[string]struct{}, len(items))
	for _, cand := range items {
		if cand.elem != item.elem && cand.id != "" {
			usedIDs[cand.id] = struct{}{}
		}
	}
	id := item.id
	if id == "" {
		id = preferredID
	}
	for idx := 2; ; idx++ {
		if _, used := usedIDs[id]; !used {
			break
		}
		id = fmt.Sprintf("%s-%d", preferredID, idx)
	}
	href := relativeHref(doc.opfPath, targetPath)
	item.elem.CreateAttr("id", id)
	item.elem.CreateAttr("href", href)
	item.elem.CreateAttr("media-type", mediaType)
	item.id = id
	item.href = href
	item.mediaType = mediaType
	return *item
}

func normalizeCoverMarkers(doc *epubDocument, imageItem manifestItem) {
	for _, it := range parseManifestItems(doc.manifestElem, doc.opfPath) {
		props := filterProp(it.properties, "cover-image")
		if doc.version == 3 && it.elem == imageItem.elem {
			props = append(props, "cover-image")
		}
		setProperties(it.elem, props)
	}
	for _, meta := range findAllByLocalName(doc.metadataElem, "meta") {
		if meta.SelectAttrValue("name", "") == "cover" && meta.Parent() != nil {
			meta.Parent().RemoveChild(meta)
		}
	}
	if doc.version == 2 {
		meta := createOpfChild(doc.metadataElem, "meta")
		meta.CreateAttr("name", "cover")
		meta.CreateAttr("content", imageItem.id)
	}
}

func normalizeTitlePage(doc *epubDocument, titleItem, imageItem manifestItem) {
	for _, it := range parseManifestItems(doc.manifestElem, doc.opfPath) {
		props := filterProp(it.properties, "calibre:title-page")
		if doc.version == 3 && it.elem == titleItem.elem {
			props = append(props, "calibre:title-page", "svg")
		}
		setProperties(it.elem, props)
	}
	if doc.version == 3 {
		ensureCalibrePrefix(doc.packageElem)
	}

	for _, sp := range getSpinePaths(doc) {
		idref := sp.itemref.SelectAttrValue("idref", "")
		if idref == titleItem.id || idref == imageItem.id {
			if sp.itemref.Parent() != nil {
				sp.itemref.Parent().RemoveChild(sp.itemref)
			}
		}
	}
	itemref := etree.NewElement("itemref")
	itemref.Space = doc.spineElem.Space
	itemref.CreateAttr("idref", titleItem.id)
	doc.spineElem.InsertChildAt(0, itemref)

	for _, ref := range findAllByLocalName(doc.packageElem, "reference") {
		if strings.EqualFold(ref.SelectAttrValue("type", ""), "cover") && ref.Parent() != nil {
			ref.Parent().RemoveChild(ref)
		}
	}
	if doc.version == 2 {
		guide := findChildByLocalName(doc.packageElem, "guide")
		if guide == nil {
			guide = createOpfChild(doc.packageElem, "guide")
		}
		ref := createOpfChild(guide, "reference")
		ref.CreateAttr("type", "cover")
		ref.CreateAttr("title", "Cover")
		ref.CreateAttr("href", relativeHref(doc.opfPath, titleItem.path))
	}
}

func updateSimpleCoverPage(doc *epubDocument, pagePath, imagePath string) {
	data, ok := doc.files[pagePath]
	if !ok {
		return
	}
	d, err := parseXML(data, pagePath)
	if err != nil || d.Root() == nil {
		return
	}
	var img *etree.Element
	if imgs := findAllByLocalName(d.Root(), "img"); len(imgs) > 0 {
		img = imgs[0]
	} else if svgs := findAllByLocalName(d.Root(), "image"); len(svgs) > 0 {
		img = svgs[0]
	}
	if img == nil {
		return
	}
	href := relativeHref(pagePath, imagePath)
	if img.Tag == "image" {
		if a := img.SelectAttr("xlink:href"); a != nil {
			a.Value = href
		} else {
			img.CreateAttr("href", href)
		}
	} else {
		img.CreateAttr("src", href)
	}
	if out, err := serializeXML(d); err == nil {
		doc.files[pagePath] = out
	}
}

func createTitlePage(imageHref string, keepAspectRatio bool) []byte {
	aspect := "none"
	if keepAspectRatio {
		aspect = "xMidYMid meet"
	}
	xmlStr := fmt.Sprintf(
		`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+
			`<html xmlns="%s"><head><title>Cover</title><meta name="viewport" content="width=device-width,height=device-height"/></head><body style="margin:0;padding:0"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%%" height="100%%" viewBox="0 0 1000 1600" preserveAspectRatio="%s"><image width="1000" height="1600" xlink:href="%s"/></svg></body></html>`,
		xhtmlNS,
		aspect,
		escapeXMLAttr(imageHref),
	)
	return []byte(xmlStr)
}

func escapeXMLAttr(s string) string {
	r := strings.NewReplacer("&", "&amp;", `"`, "&quot;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

func setProperties(el *etree.Element, props []string) {
	seen := make(map[string]struct{}, len(props))
	uniq := make([]string, 0, len(props))
	for _, p := range props {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; !ok {
			seen[p] = struct{}{}
			uniq = append(uniq, p)
		}
	}
	if len(uniq) > 0 {
		el.CreateAttr("properties", strings.Join(uniq, " "))
	} else {
		el.RemoveAttr("properties")
	}
}

func ensureCalibrePrefix(pkg *etree.Element) {
	raw := pkg.SelectAttrValue("prefix", "")
	if calibrePrefixRe.MatchString(raw) {
		return
	}
	val := strings.TrimSpace(strings.TrimSpace(raw) + " calibre: https://calibre-ebook.com")
	pkg.CreateAttr("prefix", val)
}

func createOpfChild(parent *etree.Element, tag string) *etree.Element {
	el := parent.CreateElement(tag)
	el.Space = parent.Space
	return el
}

func parseXML(data []byte, label string) (*etree.Document, error) {
	doc := etree.NewDocument()
	if err := doc.ReadFromBytes(data); err != nil {
		return nil, invalidEpub(fmt.Sprintf("Could not parse %s: %v", label, err), err)
	}
	if doc.Root() == nil {
		return nil, invalidEpub(fmt.Sprintf("Could not parse %s: missing document element", label), nil)
	}
	return doc, nil
}

func serializeXML(doc *etree.Document) ([]byte, error) {
	s, err := doc.WriteToString()
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.TrimSpace(s), "<?xml") {
		s = `<?xml version="1.0" encoding="UTF-8"?>` + "\n" + s
	}
	return []byte(s), nil
}

func findChildByLocalName(parent *etree.Element, localName string) *etree.Element {
	if parent == nil {
		return nil
	}
	for _, ch := range parent.ChildElements() {
		if ch.Tag == localName {
			return ch
		}
	}
	return nil
}

func findAllByLocalName(root *etree.Element, localName string) []*etree.Element {
	if root == nil {
		return nil
	}
	var out []*etree.Element
	var visit func(el *etree.Element)
	visit = func(el *etree.Element) {
		for _, ch := range el.ChildElements() {
			if ch.Tag == localName {
				out = append(out, ch)
			}
			visit(ch)
		}
	}
	visit(root)
	return out
}

func firstTextByLocalName(parent *etree.Element, localName string) string {
	for _, el := range findAllByLocalName(parent, localName) {
		if t := strings.TrimSpace(el.Text()); t != "" {
			return t
		}
	}
	return ""
}

func firstCreator(metaElem *etree.Element) string {
	for _, el := range findAllByLocalName(metaElem, "creator") {
		if t := strings.TrimSpace(el.Text()); t != "" {
			return t
		}
	}
	for _, el := range findAllByLocalName(metaElem, "author") {
		if t := strings.TrimSpace(el.Text()); t != "" {
			return t
		}
	}
	return ""
}

func attrByLocalName(el *etree.Element, localName string) string {
	for _, a := range el.Attr {
		if a.Key == localName {
			return a.Value
		}
	}
	return ""
}

func elementNS(el *etree.Element) string {
	if el == nil {
		return ""
	}
	prefix := el.Space
	for cur := el; cur != nil; cur = cur.Parent() {
		for _, a := range cur.Attr {
			if prefix == "" && a.Space == "" && a.Key == "xmlns" {
				return a.Value
			}
			if prefix != "" && a.Space == "xmlns" && a.Key == prefix {
				return a.Value
			}
		}
	}
	return ""
}

func collectText(el *etree.Element) string {
	if el == nil {
		return ""
	}
	var b strings.Builder
	var visit func(node *etree.Element)
	visit = func(node *etree.Element) {
		for _, tok := range node.Child {
			switch v := tok.(type) {
			case *etree.CharData:
				b.WriteString(v.Data)
			case *etree.Element:
				visit(v)
			}
		}
	}
	visit(el)
	return b.String()
}

func hasProp(props []string, target string) bool {
	for _, p := range props {
		if p == target {
			return true
		}
	}
	return false
}

func filterProp(props []string, remove string) []string {
	out := make([]string, 0, len(props))
	for _, p := range props {
		if p != remove {
			out = append(out, p)
		}
	}
	return out
}
